const express = require('express');
const CircuitBreaker = require('opossum');
const axios = require('axios');

const app = express();

// Retry configuration
const RETRY_COUNT = 3;
const RETRY_DELAY = 3000; // Tăng lên 3 seconds
const REQUEST_DELAY = 7000; // 10 seconds giữa các request

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
    RATE_LIMIT.requests = RATE_LIMIT.requests.filter(timestamp => 
        now - timestamp < RATE_LIMIT.TIME_WINDOW
    );

    if (RATE_LIMIT.requests.length >= RATE_LIMIT.MAX_REQUESTS) {
        const oldestRequest = RATE_LIMIT.requests[0];
        const timeToWait = Math.ceil((RATE_LIMIT.TIME_WINDOW - (now - oldestRequest)) / 1000);
        
        console.log(`[Rate Limiter] Blocked - Too many requests. Wait ${timeToWait}s`);
        return { allowed: false, timeToWait };
    }

    RATE_LIMIT.requests.push(now);
    console.log(`[Rate Limiter] Request accepted (${RATE_LIMIT.requests.length}/${RATE_LIMIT.MAX_REQUESTS})`);
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
    console.log(`[Circuit Breaker] State: ${state}`);
};

breaker.on('open', () => {
    console.log(`[Circuit Breaker] OPENED - Service unavailable. Retry in ${breaker.options.resetTimeout/1000}s`);
});

breaker.on('halfOpen', () => {
    console.log('[Circuit Breaker] HALF-OPEN - Testing service availability');
});

breaker.on('close', () => {
    console.log('[Circuit Breaker] CLOSED - Service operational');
});

breaker.on('failure', (error) => {
    if (breaker.halfOpen) {
        console.log('[Circuit Breaker] Test request failed - Reopening circuit');
    } else if (breaker.stats.failures >= breaker.volumeThreshold) {
        console.log('[Circuit Breaker] Consecutive failures limit reached');
    }
});

breaker.on('success', () => {
    if (breaker.halfOpen) {
        console.log('[Circuit Breaker] Test request succeeded - Closing circuit');
    }
});

// API endpoint with delay between requests
app.get('/api/v1/get-data', async (req, res) => {
    try {
        const result = await breaker.fire();
        res.json(result);
    } catch (error) {
        if (error.message.includes('RATE_LIMIT_EXCEEDED')) {
            return res.status(429).json({
                error: error.message
            });
        }

        if (breaker.opened) {
            return res.status(503).json({
                error: 'Service unavailable - Circuit breaker is open'
            });
        }

        if (breaker.halfOpen) {
            return res.status(503).json({
                error: 'Service unavailable - Circuit breaker is testing connection'
            });
        }

        res.status(500).json({ error: error.message });
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
