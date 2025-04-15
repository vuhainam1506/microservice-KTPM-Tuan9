const express = require('express');
const CircuitBreaker = require('opossum');
const axios = require('axios');

const app = express();

// Circuit Breaker configuration
const breaker = new CircuitBreaker(async () => {
    try {
        const response = await axios.get('http://localhost:3001/api/service-b');
        return response.data;
    } catch (error) {
        throw new Error('ECONNREFUSED');
    }
}, {
    timeout: 3000, // 3 seconds
    errorThresholdPercentage: 50, // 50% failure rate to trip
    resetTimeout: 10000, // 10 seconds to reset
    volumeThreshold: 3, // Must have at least 3 requests before tripping
    rollingCountTimeout: 10000, // 10 second window
    rollingCountBuckets: 10 // 10 buckets of 1 second each
});

// Debug logging function
const logCircuitState = () => {
    console.log('\n=== Circuit Breaker State ===');
    console.log('Current Stats:', {
        failures: breaker.stats.failures,
        successes: breaker.stats.successes,
        rejects: breaker.stats.rejects,
        total: breaker.stats.fires,
        state: breaker.status.state,
        errorRate: (breaker.stats.failures / breaker.stats.fires) * 100
    });
    console.log('Volume Threshold Met:', breaker.stats.fires >= breaker.volumeThreshold);
    console.log('Error Rate:', (breaker.stats.failures / breaker.stats.fires) * 100, '%');
    console.log('========================\n');
};

// Event listeners with enhanced logging
breaker.on('open', () => {
    console.log('\n=== Circuit Breaker OPENED ===');
    logCircuitState();
});

breaker.on('halfOpen', () => {
    console.log('\n=== Circuit Breaker HALF-OPEN ===');
    logCircuitState();
});

breaker.on('close', () => {
    console.log('\n=== Circuit Breaker CLOSED ===');
    logCircuitState();
});

breaker.on('failure', (error) => {
    console.log('\n=== Request Failed ===');
    console.log('Error:', error.message);
    logCircuitState();
    console.log(`Needs ${breaker.volumeThreshold - breaker.stats.failures} more failures to reach volume threshold`);
});

breaker.on('success', () => {
    console.log('\n=== Request Succeeded ===');
    logCircuitState();
});

// API endpoint
app.get('/api/v1/get-data', async (req, res) => {
    try {
        const result = await breaker.fire();
        res.json(result);
    } catch (error) {
        if (breaker.opened) {
            return res.status(503).json({
                message: 'Circuit Breaker is OPEN! Too many failures, service is blocked.',
                error: error.message,
                circuitBreakerState: {
                    state: breaker.status.state,
                    stats: breaker.stats,
                    volumeThresholdMet: breaker.stats.fires >= breaker.volumeThreshold,
                    errorRate: (breaker.stats.failures / breaker.stats.fires) * 100
                }
            });
        }

        res.status(503).json({
            message: 'Service B is down! Circuit Breaker is active.',
            error: error.message,
            circuitBreakerState: {
                state: breaker.status.state,
                stats: breaker.stats,
                remainingFailures: breaker.volumeThreshold - breaker.stats.failures
            }
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'UP',
        circuitBreaker: {
            state: breaker.status.state,
            stats: breaker.stats,
            opened: breaker.opened,
            volumeThresholdMet: breaker.stats.fires >= breaker.volumeThreshold,
            errorRate: (breaker.stats.failures / breaker.stats.fires) * 100
        }
    });
});

breaker.fallback(() => {
    return {
        message: "Circuit Breaker is OPEN - Service B is unavailable",
        timestamp: new Date().toISOString(),
        status: "FALLBACK"
    };
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Service A running on port ${PORT}`);
});
