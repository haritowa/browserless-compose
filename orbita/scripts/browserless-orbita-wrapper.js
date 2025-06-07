#!/usr/bin/env node

/**
 * Browserless Orbita Wrapper
 *
 * This wrapper integrates with the existing browserless Chrome instance,
 * automatically fetching fresh fingerprints from GoLogin for each browser session.
 */

const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

class BrowserlessOrbitaWrapper {
  constructor() {
    this.app = express();
    this.port = 4000;
    this.browserlessPort = 3000; // Port where browserless is already running
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

    this.setupMiddleware();
    this.waitForBrowserless();
  }

  async waitForBrowserless() {
    console.log("Waiting for browserless to be ready...");
    const maxRetries = 30;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        await axios.get(
          `http://localhost:${this.browserlessPort}/json/version`,
          { timeout: 5000 }
        );
        console.log("Browserless is ready!");
        break;
      } catch (error) {
        retries++;
        console.log(`Waiting for browserless... (${retries}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    if (retries === maxRetries) {
      console.error("Browserless failed to start within expected time");
      process.exit(1);
    }
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
        target: `http://localhost:${this.browserlessPort}`,
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
