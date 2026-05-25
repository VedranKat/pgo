FROM node:24-bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

COPY docker/pi/extensions/read-only-git.ts /opt/pi/extensions/read-only-git.ts
COPY docker/pi/entrypoint.sh /usr/local/bin/pgo-docker-entrypoint
RUN chmod +x /usr/local/bin/pgo-docker-entrypoint

USER node
ENV HOME=/home/node
WORKDIR /workspace

ENTRYPOINT ["pgo-docker-entrypoint"]
CMD ["bash"]
