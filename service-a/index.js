const express = require('express');
const CircuitBreaker = require('opossum');
const axios = require('axios');

const app = express();

// Retry configuration
const RETRY_COUNT = 3;
const RETRY_DELAY = 3000; // Tăng lên 3 seconds
const REQUEST_DELAY = 3000; // 10 seconds giữa các request

// Rate Limiter configuration
const RATE_LIMIT = {
    MAX_REQUESTS: 5,  // 5 requests
    TIME_WINDOW: 60000,  // 1 minute (in milliseconds)
    requests: [],
};

// Helper function to delay execution
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to check rate limit
function checkRateLimit() {
    const now = Date.now();
    
    // Remove requests older than TIME_WINDOW
    RATE_LIMIT.requests = RATE_LIMIT.requests.filter(timestamp => 
        now - timestamp < RATE_LIMIT.TIME_WINDOW
    );

    // Check if we've hit the limit
    if (RATE_LIMIT.requests.length >= RATE_LIMIT.MAX_REQUESTS) {
        const oldestRequest = RATE_LIMIT.requests[0];
        const timeToWait = RATE_LIMIT.TIME_WINDOW - (now - oldestRequest);
        return {
            allowed: false,
            timeToWait: Math.ceil(timeToWait / 1000)
        };
    }

    // Add new request timestamp
    RATE_LIMIT.requests.push(now);
    return { allowed: true };
}

// Circuit Breaker configuration
const breaker = new CircuitBreaker(async () => {
    // Check rate limit before making request
    const rateLimitCheck = checkRateLimit();
    if (!rateLimitCheck.allowed) {
        throw new Error(`RATE_LIMIT_EXCEEDED: Try again in ${rateLimitCheck.timeToWait} seconds`);
    }

    let lastError;
    
    // Retry logic
    for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
        try {
            if (attempt > 1) {
                console.log(`\n=== Retry Attempt ${attempt-1} of ${RETRY_COUNT} ===`);
                console.log(`Waiting ${RETRY_DELAY/1000} seconds before retry...`);
                await delay(RETRY_DELAY);
            }
            
            const response = await axios.get('http://localhost:3001/api/service-b');
            if (attempt > 1) {
                console.log(`Retry attempt ${attempt-1} successful`);
            }
            return response.data;
            
        } catch (error) {
            lastError = error;
            console.log(`Attempt ${attempt} failed:`, error.message);
            
            if (attempt === RETRY_COUNT) {
                throw new Error('ECONNREFUSED');
            }
        }
    }
}, {
    timeout: 5000, // Tăng lên 5 seconds
    errorThresholdPercentage: 50,
    resetTimeout: 10000,
    volumeThreshold: 3,
    rollingCountTimeout: 10000,
    rollingCountBuckets: 10
});

// Debug logging function
const logCircuitState = () => {
    const state = breaker.opened ? 'OPEN' : 
                 breaker.halfOpen ? 'HALF-OPEN' : 
                 breaker.closed ? 'CLOSED' : 'UNKNOWN';
                 
    console.log('\n=== Circuit Breaker State ===');
    console.log('Current Stats:', {
        failures: breaker.stats.failures,
        successes: breaker.stats.successes,
        rejects: breaker.stats.rejects,
        total: breaker.stats.fires,
        state: state
    });
    console.log('Consecutive Failures:', breaker.stats.failures);
    console.log('Current State:', state);
    console.log('========================\n');
};

breaker.on('open', () => {
    console.log('\n=== Circuit Breaker OPENED after 3 consecutive failures ===');
    console.log(`Circuit will attempt to half-open in ${breaker.options.resetTimeout/1000} seconds`);
    logCircuitState();

    // Set timeout to log when circuit goes to half-open
    setTimeout(() => {
        if (breaker.halfOpen) {
            const timestamp = new Date().toISOString();
            console.log('\n=== Circuit Breaker State Change ===');
            console.log(`Timestamp: ${timestamp}`);
            console.log('State: HALF-OPEN');
            console.log('Action: Testing service availability with a single request');
            console.log('Note: If this request fails, circuit will re-open');
            console.log('      If request succeeds, circuit will close');
            logCircuitState();
        }
    }, breaker.options.resetTimeout);
});

breaker.on('halfOpen', () => {
    const timestamp = new Date().toISOString();
    console.log('\n=== Circuit Breaker State Change ===');
    console.log(`Timestamp: ${timestamp}`);
    console.log('State: HALF-OPEN');
    console.log('Action: Testing service availability with a single request');
    console.log('Note: If this request fails, circuit will re-open');
    console.log('      If request succeeds, circuit will close');
    logCircuitState();
});

breaker.on('close', () => {
    console.log('\n=== Circuit Breaker CLOSED - Service is operational ===');
    console.log('Previous state:', breaker.status.state);
    console.log('Service has recovered and is accepting requests normally');
    logCircuitState();
});

breaker.on('failure', (error) => {
    console.log('\n=== Call failed:', error.message);
    console.log('Current failure count:', breaker.stats.failures);
    if (breaker.halfOpen) {
        console.log('Failure during half-open state - Circuit will re-open');
    } else if (breaker.stats.failures >= breaker.volumeThreshold) {
        console.log('Maximum consecutive failures reached - Circuit will open');
    }
    logCircuitState();
});

breaker.on('success', () => {
    console.log('\n=== Call succeeded - Service is operational ===');
    if (breaker.halfOpen) {
        console.log('Success during half-open state - Circuit will close');
    }
    logCircuitState();
});

// API endpoint with delay between requests
app.get('/api/v1/get-data', async (req, res) => {
    try {
        console.log('\n=== New Request ===');
        console.log(`Waiting ${REQUEST_DELAY/1000} seconds before processing...`);
        await delay(REQUEST_DELAY);
        
        const result = await breaker.fire();
        res.json(result);
    } catch (error) {
        if (error.message.includes('RATE_LIMIT_EXCEEDED')) {
            return res.status(429).json({
                message: 'Rate limit exceeded',
                error: error.message,
                note: 'Maximum 5 requests allowed per minute'
            });
        }

        if (breaker.opened) {
            return res.status(503).json({
                message: 'Service B is unavailable - Circuit Breaker is OPEN',
                error: 'Maximum consecutive failures reached',
                circuitState: {
                    state: breaker.status.state,
                    consecutiveFailures: breaker.stats.failures,
                    nextAttempt: `Circuit will try again in ${breaker.options.resetTimeout/1000} seconds`
                }
            });
        }

        if (breaker.halfOpen) {
            return res.status(503).json({
                message: 'Service B is being tested - Circuit Breaker is HALF-OPEN',
                error: error.message,
                circuitState: {
                    state: breaker.status.state,
                    consecutiveFailures: breaker.stats.failures,
                    note: 'Testing single request to check service availability'
                }
            });
        }

        res.status(503).json({
            message: 'Service B is down',
            error: error.message,
            circuitState: {
                state: breaker.status.state,
                consecutiveFailures: breaker.stats.failures,
                remainingAttempts: breaker.volumeThreshold - breaker.stats.failures
            }
        });
    }
});

breaker.fallback(() => {
    return {
        message: "Service B is unavailable",
        timestamp: new Date().toISOString(),
        status: "FALLBACK"
    };
});

// Add endpoint to check current rate limit status
app.get('/api/v1/rate-limit-status', (req, res) => {
    const now = Date.now();
    const activeRequests = RATE_LIMIT.requests.filter(timestamp => 
        now - timestamp < RATE_LIMIT.TIME_WINDOW
    ).length;

    res.json({
        maxRequests: RATE_LIMIT.MAX_REQUESTS,
        timeWindow: `${RATE_LIMIT.TIME_WINDOW/1000} seconds`,
        currentRequests: activeRequests,
        remainingRequests: RATE_LIMIT.MAX_REQUESTS - activeRequests,
        requestHistory: RATE_LIMIT.requests.map(timestamp => new Date(timestamp).toISOString())
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Service A running on port ${PORT}`);
});
