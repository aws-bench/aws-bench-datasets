FROM public.ecr.aws/docker/library/python:3.13-slim

# Install uv
RUN ARCH=$(uname -m) && \
    python -c "import urllib.request,sys; urllib.request.urlretrieve(f'https://github.com/astral-sh/uv/releases/download/0.11.23/uv-{sys.argv[1]}-unknown-linux-gnu.tar.gz', '/tmp/uv.tar.gz')" "$ARCH" && \
    tar xzf /tmp/uv.tar.gz -C /usr/local/bin/ --strip-components=1 && rm /tmp/uv.tar.gz

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip less groff jq zip \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 (detect architecture)
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
        CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip"; \
    else \
        CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"; \
    fi && \
    curl -sSL "$CLI_URL" -o /tmp/awscliv2.zip && \
    unzip -q /tmp/awscliv2.zip -d /tmp && \
    /tmp/aws/install && \
    rm -rf /tmp/aws /tmp/awscliv2.zip

# Install websocat (needed by pre_invoke agent script)
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
        WEBSOCAT_URL="https://github.com/vi/websocat/releases/download/v1.13.0/websocat.aarch64-unknown-linux-musl"; \
    else \
        WEBSOCAT_URL="https://github.com/vi/websocat/releases/download/v1.13.0/websocat.x86_64-unknown-linux-musl"; \
    fi && \
    curl -sfL "$WEBSOCAT_URL" -o /usr/local/bin/websocat && \
    chmod +x /usr/local/bin/websocat

# Pre-install verifier dependencies
RUN uv pip install --system --no-cache harbor-rewardkit boto3 pyyaml

WORKDIR /app
