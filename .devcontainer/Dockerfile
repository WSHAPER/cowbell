FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends git tmux curl ca-certificates hyperfine \
 && rm -rf /var/lib/apt/lists/*

# herdr release binary (the substrate under test)
ARG HERDR_VERSION=0.9.5
RUN curl -fsSL "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-${HERDR_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      -o /tmp/herdr.tgz \
 && tar -xzf /tmp/herdr.tgz -C /usr/local/bin --strip-components=1 \
 && rm /tmp/herdr.tgz \
 && herdr --version

WORKDIR /workspace
