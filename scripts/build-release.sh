#!/usr/bin/env bash
set -euo pipefail

version=$1
artifacts=$2
tag="v$version"
farm="openfarm-farm:$tag"
connector="openfarm-connector:$tag"
OPENFARM_DOCKER_REHEARSAL=1 node --test tests/docker/upgrade-rehearsal.test.ts
mkdir -p "$artifacts"

runtime=$(mktemp -d)
container=
farm_container=
cleanup() {
  if [[ -n "$container" ]]; then
    docker rm -v "$container" >/dev/null
  fi
  if [[ -n "$farm_container" ]]; then
    docker rm -fv "$farm_container" >/dev/null
  fi
  rm -rf "$runtime"
}
trap cleanup EXIT

docker build --platform linux/amd64 -f apps/farm/Dockerfile -t "$farm" .
docker build --platform linux/amd64 -f packages/connector/Dockerfile -t "$connector" .
[[ "$(docker run --rm --platform linux/amd64 --network none "$connector" --version)" == "$version" ]]

farm_container=$(docker run -d --platform linux/amd64 --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges "$farm")
for attempt in {1..30}; do
  if docker exec "$farm_container" node -e '
    fetch("http://127.0.0.1:3000/healthz")
      .then(async (response) => {
        process.exitCode = Number(!response.ok || (await response.json()).version !== process.argv[1])
      })
      .catch(() => { process.exitCode = 1 })
  ' "$version"; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then
    docker logs "$farm_container" >&2
    exit 1
  fi
  sleep 1
done

docker save "$farm" | gzip > "$artifacts/farm-$tag-image.tar.gz"
docker save "$connector" | gzip > "$artifacts/connector-$tag-image.tar.gz"

container=$(docker create --platform linux/amd64 "$connector")
docker cp "$container:/app/." "$runtime/"
printf '{"type":"module"}\n' > "$runtime/package.json"
mkdir -p "$runtime/notices"
cp -a packages/connector/notices/node-datachannel "$runtime/notices/"
tar -czf "$artifacts/connector-$tag-linux-amd64.tar.gz" -C "$runtime" .

(
  cd "$artifacts"
  sha256sum "farm-$tag-image.tar.gz" "connector-$tag-image.tar.gz" \
    "connector-$tag-linux-amd64.tar.gz" > SHA256SUMS
  sha256sum -c SHA256SUMS
)
