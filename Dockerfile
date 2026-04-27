FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://raw.githubusercontent.com/AxmeAI/axme-code/main/install.sh | bash

ENV PATH="/root/.local/bin:${PATH}"
ENV AXME_TELEMETRY_DISABLED=1

WORKDIR /workspace

ENTRYPOINT ["axme-code", "serve"]
