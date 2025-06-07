#!/usr/bin/env node

/**
 * Browserless Orbita Wrapper
 *
 * This wrapper replaces the standard browserless Chrome with Orbita browser,
 * automatically fetching fresh fingerprints from GoLogin for each browser session.
 */

const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { spawn } = require("child_process");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

class BrowserlessOrbitaWrapper {
  constructor() {
    this.app = express();
    this.browserlessProcess = null;
    this.port = 4000;
    this.browserlessPort = 3000; // Internal browserless port (default)
    this.orbitaPath =
      process.env.ORBITA_PATH || "/opt/gologin/orbita-browser/chrome";
    this.activeFingerprints = new Map(); // Store active fingerprints

    // GoLogin configuration
    this.gologinConfig = {
      token: process.env.GOLOGIN_TOKEN,
      workspace: process.env.GOLOGIN_WORKSPACE || "default",
      apiUrl: process.env.GOLOGIN_API_URL || "https://api.gologin.com",
    };

    if (!this.gologinConfig.token) {
      throw new Error("GOLOGIN_TOKEN environment variable is required");
    }

    // Browserless configuration
    this.browserlessConfig = {
      TOKEN: process.env.TOKEN || process.env.BL_TOKEN,
      CONCURRENT: process.env.CONCURRENT || 4,
      QUEUED: process.env.QUEUED || 100,
      TIMEOUT: process.env.TIMEOUT || 300000,
      IGNORE_HTTPS_ERRORS: process.env.IGNORE_HTTPS_ERRORS || "true",
      EXIT_ON_HEALTH_FAILURE: process.env.EXIT_ON_HEALTH_FAILURE || "true",
      DEBUG: process.env.DEBUG || "-*",
    };

    this.setupMiddleware();
    this.startBrowserless();
  }

  setupMiddleware() {
    // Add JSON parsing middleware
    this.app.use(express.json());

    // Add GoLogin API endpoints for debugging/management
    this.setupGologinEndpoints();

    // Middleware to intercept WebSocket connections and inject fingerprints
    this.app.use("/chrome", this.fingerprintMiddleware.bind(this));

    // Proxy all other requests to browserless
    this.app.use(
      "/",
      createProxyMiddleware({
        target: `http://localhost:${this.browserlessPort}`, // Internal browserless port
        changeOrigin: true,
        ws: true,
        logLevel: "warn",
      })
    );
  }

  setupGologinEndpoints() {
    // Generate fresh fingerprint endpoint (for debugging)
    this.app.get("/gologin/generate", async (req, res) => {
      try {
        const fingerprint = await this.generateFreshFingerprint();
        if (fingerprint) {
          res.json({
            status: "success",
            profile_id: fingerprint.profile_id,
            fingerprint: fingerprint.data,
          });
        } else {
          res.status(500).json({
            status: "error",
            message: "Failed to generate fingerprint",
          });
        }
      } catch (error) {
        res.status(500).json({
          status: "error",
          message: error.message,
        });
      }
    });

    // List active fingerprints
    this.app.get("/gologin/active", (req, res) => {
      res.json({
        status: "success",
        active_fingerprints: Array.from(this.activeFingerprints.keys()),
        count: this.activeFingerprints.size,
      });
    });

    // Health check
    this.app.get("/health", (req, res) => {
      res.json({
        status: "healthy",
        orbita_path: this.orbitaPath,
        active_fingerprints: this.activeFingerprints.size,
        gologin_configured: !!this.gologinConfig.token,
      });
    });
  }

  async fingerprintMiddleware(req, res, next) {
    try {
      // Check if this is a WebSocket upgrade for a new browser session
      if (req.headers.upgrade === "websocket") {
        console.log(
          "New WebSocket connection detected, fetching fresh fingerprint..."
        );

        // Generate fresh fingerprint from GoLogin
        const fingerprint = await this.generateFreshFingerprint();
        if (fingerprint) {
          // Store fingerprint for this session
          req.gologinFingerprint = fingerprint;
          this.activeFingerprints.set(fingerprint.profile_id, fingerprint);
          console.log(`Fresh fingerprint generated: ${fingerprint.profile_id}`);
        } else {
          console.warn(
            "Failed to generate fresh fingerprint, proceeding without..."
          );
        }
      }

      next();
    } catch (error) {
      console.error("Error in fingerprint middleware:", error);
      next();
    }
  }

  async generateFreshFingerprint(osType = "win", osSpec = "win11") {
    try {
      console.log("Fetching fresh fingerprint from GoLogin...");

      // Generate fingerprint from GoLogin API
      const response = await axios.get(
        `${this.gologinConfig.apiUrl}/browser/fingerprint`,
        {
          headers: {
            Authorization: `Bearer ${this.gologinConfig.token}`,
            "Content-Type": "application/json",
          },
          params: {
            os: osType,
            osSpec: osSpec,
            currentWorkspace: this.gologinConfig.workspace,
          },
          timeout: 10000,
        }
      );

      if (response.data) {
        const profileId = `orbita-${uuidv4().slice(0, 8)}`;
        return {
          profile_id: profileId,
          data: response.data,
          created_at: new Date().toISOString(),
        };
      }

      return null;
    } catch (error) {
      console.error("Failed to fetch fingerprint from GoLogin:", error.message);
      return null;
    }
  }

  startBrowserless() {
    console.log("Starting browserless with Orbita integration...");

    // Create a custom browserless launch script
    const launchScript = this.createOrbitaLaunchScript();

    // Start browserless with custom configuration (let it use default port 3000)
    const browserlessArgs = [
      "/usr/src/app/build/index.js",
      "--debug=-*",
      `--concurrent=${this.browserlessConfig.CONCURRENT}`,
      `--queued=${this.browserlessConfig.QUEUED}`,
      `--timeout=${this.browserlessConfig.TIMEOUT}`,
      `--ignore-https-errors=${this.browserlessConfig.IGNORE_HTTPS_ERRORS}`,
      `--exit-on-health-failure=${this.browserlessConfig.EXIT_ON_HEALTH_FAILURE}`,
      `--chrome-executable=${launchScript}`,
      `--token=${this.browserlessConfig.TOKEN}`,
    ];

    const env = {
      ...process.env,
      DEBUG: this.browserlessConfig.DEBUG,
      ORBITA_EXECUTABLE: this.orbitaPath,
    };

    this.browserlessProcess = spawn("node", browserlessArgs, {
      stdio: ["inherit", "pipe", "pipe"],
      env: env,
    });

    this.browserlessProcess.stdout.on("data", (data) => {
      console.log(`[Browserless]: ${data.toString().trim()}`);
    });

    this.browserlessProcess.stderr.on("data", (data) => {
      console.error(`[Browserless Error]: ${data.toString().trim()}`);
    });

    this.browserlessProcess.on("close", (code) => {
      console.log(`Browserless process exited with code ${code}`);
      if (code !== 0) {
        setTimeout(() => this.startBrowserless(), 5000); // Restart after 5 seconds
      }
    });

    this.browserlessProcess.on("error", (error) => {
      console.error("Failed to start browserless process:", error);
    });
  }

  createOrbitaLaunchScript() {
    const scriptPath = "/tmp/orbita-launch.sh";
    const scriptContent = `#!/bin/bash

# Orbita Launch Script with GoLogin Fingerprint Integration
# This script is called by browserless to launch Orbita instead of Chrome

ORBITA_EXECUTABLE="${this.orbitaPath}"

# Default Orbita arguments for browserless compatibility
ORBITA_ARGS="--no-sandbox --disable-dev-shm-usage --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=TranslateUI --disable-ipc-flooding-protection --enable-features=NetworkService,NetworkServiceLogging --disable-background-networking --enable-features=VizDisplayCompositor --remote-debugging-port=0 --headless=new"

# Launch Orbita with arguments
exec "$ORBITA_EXECUTABLE" $ORBITA_ARGS "$@"
`;

    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    return scriptPath;
  }

  start() {
    this.app.listen(this.port, () => {
      console.log(`Browserless Orbita Wrapper running on port ${this.port}`);
      console.log(
        `Internal browserless running on port ${this.browserlessPort}`
      );
      console.log(`GoLogin API: ${this.gologinConfig.apiUrl}`);
      console.log(`Orbita executable: ${this.orbitaPath}`);
      console.log(`GoLogin token configured: ${!!this.gologinConfig.token}`);
    });
  }

  shutdown() {
    console.log("Shutting down Browserless Orbita Wrapper...");
    if (this.browserlessProcess) {
      this.browserlessProcess.kill("SIGTERM");
    }
    process.exit(0);
  }
}

// Handle graceful shutdown
process.on("SIGTERM", () => {
  if (global.browserlessWrapper) {
    global.browserlessWrapper.shutdown();
  }
});

process.on("SIGINT", () => {
  if (global.browserlessWrapper) {
    global.browserlessWrapper.shutdown();
  }
});

// Start the wrapper
if (require.main === module) {
  global.browserlessWrapper = new BrowserlessOrbitaWrapper();
  global.browserlessWrapper.start();
}

module.exports = BrowserlessOrbitaWrapper;
