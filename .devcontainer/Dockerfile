FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux curl ca-certificates hyperfine \
 && rm -rf /var/lib/apt/lists/*

# herdr release binary (the substrate under test). Releases ship bare
# binaries named herdr-<os>-<arch> (the 0.9.5 tarball asset no longer
# exists; asset list verified via the GitHub API — naming held across
# v0.9.4/v0.9.5/preview).
# BUMP PROTOCOL (keep in sync, one commit):
#   1. gh api repos/herdrdev/herdr/releases --jq '.[0].assets[].name'  (re-verify naming)
#   2. this ARG
#   3. SUPPORTED_HERDR_VERSION in src/herdr/spec.ts
#   4. npm run reference:surface  (re-capture; drift suite must stay green)
#   5. the herdr badge in README.md
ARG HERDR_VERSION=0.9.5
RUN curl -fsSL "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-x86_64" \
      -o /usr/local/bin/herdr \
 && chmod +x /usr/local/bin/herdr \
 && herdr --version

WORKDIR /workspace
