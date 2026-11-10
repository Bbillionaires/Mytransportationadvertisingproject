#!/usr/bin/env bash
# Read-only security probe of a deployed instance (R-015 preparation). Polite: ~30 requests, no load, no data written
# except failed sign-ins for a non-existent address. Run after each deploy:
#   bash infra/security-probe.sh https://api-production-81031.up.railway.app
set -u
U="${1:?usage: security-probe.sh https://your-app}"
fail=0
pass() { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }
hdr()  { curl -s -D - -o /dev/null "$@" | tr -d '\r'; }

H=$(hdr "$U/portal/index.html")
for h in 'content-security-policy:' "frame-ancestors 'none'" 'strict-transport-security: max-age=' 'x-content-type-options: nosniff' 'referrer-policy: no-referrer' 'x-frame-options: DENY'; do
  grep -qi -- "$h" <<<"$H" && pass "portal header $h" || bad "portal header $h missing"
done
grep -qi "script-src 'self';" <<<"$H" && pass "CSP allows only own scripts" || bad "CSP script-src is not 'self' only"

A=$(hdr "$U/v1/me")
grep -qi 'cache-control: no-store' <<<"$A" && pass 'API responses not cacheable' || bad 'API responses missing cache-control: no-store'

c=$(curl -s -o /dev/null -w '%{http_code}' "http://${U#https://}/portal/"); [ "$c" = 301 ] || [ "$c" = 308 ] && pass "plain HTTP redirects ($c)" || bad "plain HTTP answered $c"
c=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$U/v1/auth/login" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST')
grep -qi 'access-control-allow-origin' < <(hdr -X OPTIONS "$U/v1/auth/login" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST') && bad 'CORS allows a foreign origin' || pass "no CORS for foreign origins ($c)"

for p in /portal/portal.js.map /player/player.js.map /rider/rider.js.map /.env /.git/config /package.json /apps/api/.env; do
  c=$(curl -s -o /dev/null -w '%{http_code}' "$U$p"); [ "$c" = 404 ] && pass "not served: $p" || bad "served ($c): $p"
done
c=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$U/portal/../../package.json"); [ "$c" = 404 ] && pass 'path traversal refused' || bad "path traversal answered $c"
c=$(curl -s -o /dev/null -w '%{http_code}' "$U/metrics"); [ "$c" = 401 ] || [ "$c" = 404 ] && pass "metrics need a token ($c)" || bad "metrics open ($c)"
c=$(curl -s -o /dev/null -w '%{http_code}' -X TRACE "$U/v1/me"); [ "$c" != 200 ] && pass "TRACE not allowed ($c)" || bad 'TRACE answered 200'

B=$(curl -s -X POST "$U/v1/auth/login" -H 'content-type: application/json' -d '{bad')
grep -q '"BAD_JSON"' <<<"$B" && ! grep -qi 'stack\|at .*\.ts' <<<"$B" && pass 'malformed JSON: clean error' || bad "malformed JSON: $B"
B=$(curl -s "$U/v1/nope"); grep -q '"NOT_FOUND"' <<<"$B" && ! grep -q 'Route GET' <<<"$B" && pass 'unknown route: app error shape' || bad "unknown route: $B"
c=$(head -c 3000000 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '%{http_code}' -X POST "$U/v1/auth/login" -H 'content-type: application/json' --data-binary @-)
[ "$c" = 413 ] && pass 'oversized body refused (413)' || bad "oversized body answered $c"

# Rate limit: the counter must fall with each sign-in attempt from one address and must not follow a forged
# X-Forwarded-For. (From a rotating egress proxy, counters differ per egress address; that is still per-address.)
r=$(for i in 1 2 3; do hdr -X POST "$U/v1/auth/login" -H "X-Forwarded-For: 203.0.113.$((RANDOM % 200))" -H 'content-type: application/json' \
  -d '{"email":"probe-nobody@example.invalid","password":"wrong-password-123"}' | grep -i x-ratelimit-limit | awk '{print $2}'; done | sort -u)
[ "$r" = 10 ] && pass 'sign-in limited to 10 per minute per address' || bad "sign-in rate limit header: '$r'"

[ $fail = 0 ] && echo 'All checks passed.' || { echo 'Some checks FAILED.'; exit 1; }
