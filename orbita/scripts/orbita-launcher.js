#!/usr/bin/env node

/**
 * Orbita Launcher with GoLogin Fingerprint API
 *
 * This script replaces the Chrome executable for browserless and automatically
 * fetches fresh fingerprints from GoLogin's API for each browser session.
 */

const fs = require("fs").promises;
const path = require("path");
const { spawn } = require("child_process");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

class OrbitaLauncher {
  constructor() {
    this.orbitaPath =
      process.env.ORBITA_PATH || "/opt/gologin/orbita-browser/chrome";
    this.profileDir = "/tmp/orbita-profiles";

    // GoLogin configuration
    this.gologinConfig = {
      token: process.env.GOLOGIN_TOKEN,
      workspace: process.env.GOLOGIN_WORKSPACE || "default",
      apiUrl: process.env.GOLOGIN_API_URL || "https://api.gologin.com",
    };

    if (!this.gologinConfig.token) {
      throw new Error("GOLOGIN_TOKEN environment variable is required");
    }
  }

  async ensureProfileDir() {
    try {
      await fs.mkdir(this.profileDir, { recursive: true });
    } catch (error) {
      console.warn("Failed to create profile directory:", error.message);
    }
  }

  async fetchGologinFingerprint(os = "win", osSpec = "win11") {
    const maxRetries = 2;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        console.log(
          `Fetching fingerprint from GoLogin API (attempt ${attempt}/${
            maxRetries + 1
          })...`
        );

        const response = await axios.get(
          `${this.gologinConfig.apiUrl}/browser/fingerprint`,
          {
            headers: {
              Authorization: `Bearer ${this.gologinConfig.token}`,
            },
            params: {
              os: os,
              osSpec: osSpec,
              currentWorkspace: this.gologinConfig.workspace,
            },
            timeout: 10000,
          }
        );

        if (response.data) {
          console.log(
            `GoLogin fingerprint fetched - UA: ${response.data.navigator?.userAgent?.slice(
              0,
              50
            )}...`
          );
          console.log(
            `Resolution: ${response.data.navigator?.resolution}, Platform: ${response.data.navigator?.platform}`
          );

          // Add session ID for tracking
          response.data.sessionId = uuidv4();
          return response.data;
        }

        throw new Error("Invalid response from GoLogin API");
      } catch (error) {
        lastError = error;
        console.error(`GoLogin API attempt ${attempt} failed:`, error.message);

        if (attempt <= maxRetries) {
          const delay = attempt * 1000; // 1s, 2s delay between retries
          console.log(`Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All retries failed
    throw new Error(
      `Failed to fetch fingerprint from GoLogin API after ${
        maxRetries + 1
      } attempts. Last error: ${lastError.message}`
    );
  }

  async setupProfileDirectory(fingerprint) {
    try {
      const profilePath = path.join(this.profileDir, fingerprint.sessionId);
      await fs.mkdir(profilePath, { recursive: true });

      // Create Default directory for Chrome profile
      const defaultPath = path.join(profilePath, "Default");
      await fs.mkdir(defaultPath, { recursive: true });

      // Create basic preferences based on fingerprint
      const preferences = {
        profile: {
          default_content_setting_values: {
            geolocation: 2, // Block geolocation by default
          },
        },
        intl: {
          accept_languages: fingerprint.navigator?.language || "en-US,en",
        },
      };

      await fs.writeFile(
        path.join(defaultPath, "Preferences"),
        JSON.stringify(preferences, null, 2)
      );

      console.log(`Profile directory created: ${profilePath}`);
      return profilePath;
    } catch (error) {
      console.error("Failed to setup profile directory:", error);
      return null;
    }
  }

  buildOrbitaArgs(fingerprint, profilePath, originalArgs) {
    const args = [...originalArgs];
    const navigator = fingerprint.navigator;

    console.log(`Applying fingerprint for session: ${fingerprint.sessionId}`);

    // User data directory
    if (profilePath) {
      args.push(`--user-data-dir=${profilePath}`);
    }

    // User agent
    if (navigator?.userAgent) {
      args.push(`--user-agent=${navigator.userAgent}`);
    }

    // Window size based on resolution
    if (navigator?.resolution) {
      const [width, height] = navigator.resolution.split("x");
      args.push(`--window-size=${width},${height}`);
    }

    // Language
    if (navigator?.language) {
      const primaryLang = navigator.language.split(",")[0];
      args.push(`--lang=${primaryLang}`);
      args.push(`--accept-lang=${navigator.language}`);
    }

    // Platform-specific arguments
    if (navigator?.platform) {
      // Adjust based on platform
      if (navigator.platform.includes("Mac")) {
        args.push("--enable-font-subpixel-positioning");
      }
    }

    // Hardware concurrency
    if (navigator?.hardwareConcurrency) {
      args.push(`--max-old-space-size=${(navigator.deviceMemory || 8) * 1024}`);
    }

    // Canvas and WebGL fingerprinting based on GoLogin settings
    if (fingerprint.canvas?.mode === "off") {
      args.push("--disable-canvas-aa");
      args.push("--disable-2d-canvas-clip-aa");
    }

    if (fingerprint.webGLMetadata?.mode === "off") {
      args.push("--disable-webgl");
      args.push("--disable-webgl2");
    }

    // Essential browser arguments
    const essentialArgs = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=TranslateUI",
      "--disable-ipc-flooding-protection",
      "--enable-features=NetworkService,NetworkServiceLogging",
      "--disable-background-networking",
      "--remote-debugging-port=0",
      "--allow-pre-commit-input",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ];

    // Add essential args if not already present
    essentialArgs.forEach((arg) => {
      const argKey = arg.split("=")[0];
      if (!args.some((a) => a.startsWith(argKey))) {
        args.push(arg);
      }
    });

    return args;
  }

  async cleanupOldProfiles() {
    try {
      const profiles = await fs.readdir(this.profileDir);
      const cutoffTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours

      for (const sessionId of profiles) {
        const profilePath = path.join(this.profileDir, sessionId);
        const stats = await fs.stat(profilePath);

        if (stats.mtime.getTime() < cutoffTime) {
          await fs.rmdir(profilePath, { recursive: true });
          console.log(`Cleaned up old profile: ${sessionId}`);
        }
      }
    } catch (error) {
      console.warn("Failed to cleanup old profiles:", error.message);
    }
  }

  async launch() {
    try {
      // Ensure profile directory exists
      await this.ensureProfileDir();

      // Clean up old profiles
      await this.cleanupOldProfiles();

      // Fetch fresh fingerprint from GoLogin API (will throw on failure)
      const fingerprint = await this.fetchGologinFingerprint();

      // Setup profile directory with Chrome configuration
      const profilePath = await this.setupProfileDirectory(fingerprint);

      // Get original arguments passed to this script
      const originalArgs = process.argv.slice(2);

      // Build Orbita arguments with fingerprint configuration
      const orbitaArgs = this.buildOrbitaArgs(
        fingerprint,
        profilePath,
        originalArgs
      );

      console.log(`Launching Orbita: ${this.orbitaPath}`);
      console.log(`Arguments: ${orbitaArgs.join(" ")}`);

      // Launch Orbita
      const orbitaProcess = spawn(this.orbitaPath, orbitaArgs, {
        stdio: "inherit",
        env: process.env,
      });

      // Handle process events
      orbitaProcess.on("error", (error) => {
        console.error("Failed to start Orbita:", error);
        process.exit(1);
      });

      orbitaProcess.on("close", async (code) => {
        console.log(`Orbita exited with code ${code}`);

        // Cleanup profile directory after browser closes
        if (profilePath && fingerprint) {
          try {
            await fs.rmdir(profilePath, { recursive: true });
            console.log(`Cleaned up session: ${fingerprint.sessionId}`);
          } catch (error) {
            console.warn(`Failed to cleanup session: ${error.message}`);
          }
        }

        process.exit(code);
      });

      // Handle shutdown signals
      const shutdown = async (signal) => {
        console.log(`Received ${signal}, shutting down Orbita...`);
        orbitaProcess.kill(signal);
      };

      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    } catch (error) {
      console.error("Failed to launch Orbita:", error.message);
      process.exit(1);
    }
  }
}

// Start the launcher
if (require.main === module) {
  const launcher = new OrbitaLauncher();
  launcher.launch();
}

module.exports = OrbitaLauncher;
