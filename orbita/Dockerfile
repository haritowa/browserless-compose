# Start from the official browserless base image  
FROM ghcr.io/browserless/chromium:latest

USER root

# Install system dependencies
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    tar \
    && rm -rf /var/lib/apt/lists/*

# Create directory structure
RUN mkdir -p /opt/gologin /opt/browserless-orbita

# Download and install Orbita browser
WORKDIR /opt/gologin
RUN wget -O orbita.tar.gz \
    "https://releases-deb-orbita.s3.eu-central-1.amazonaws.com/orbita-browser-latest.tar.gz" && \
    tar -xzf orbita.tar.gz && \
    rm orbita.tar.gz && \
    chmod +x orbita-browser/chrome

# Set up Node.js application
WORKDIR /opt/browserless-orbita
COPY scripts/package.json ./
RUN npm install

# Copy application scripts
COPY scripts/ ./

# Set proper ownership
RUN chown -R blessuser:blessuser /opt/gologin /opt/browserless-orbita

# Switch to browserless user
USER blessuser

# Environment variables for browserless
ENV CHROME_EXECUTABLE="/opt/gologin/orbita-browser/chrome"
ENV ORBITA_PATH="/opt/gologin/orbita-browser/chrome"
ENV NODE_ENV="production"

# Expose port for the wrapper
EXPOSE 4000

# Copy and set up startup script
WORKDIR /opt/browserless-orbita
RUN chmod +x start.sh

# Run the startup script
CMD ["/bin/bash", "/opt/browserless-orbita/start.sh"]
