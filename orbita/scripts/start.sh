#!/bin/bash

# Start browserless in the background from its proper directory
cd /usr/src/app
node /usr/src/app/build/index.js &
BROWSERLESS_PID=$!

# Switch back to our working directory
cd /opt/browserless-orbita

# Wait a moment for browserless to start
sleep 3

# Start the wrapper (which will wait for browserless to be ready)
node /opt/browserless-orbita/browserless-orbita-wrapper.js &
WRAPPER_PID=$!

# Function to handle shutdown
shutdown() {
    echo "Shutting down..."
    kill $WRAPPER_PID $BROWSERLESS_PID
    wait $WRAPPER_PID $BROWSERLESS_PID
    exit 0
}

# Trap signals
trap shutdown SIGTERM SIGINT

# Wait for both processes
wait $WRAPPER_PID $BROWSERLESS_PID 