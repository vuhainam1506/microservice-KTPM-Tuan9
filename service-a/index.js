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
    errorThresholdPercentage: 50, // Changed from 100 to 50
    resetTimeout: 10000, // 10 seconds until half-open
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

// API endpoint
app.get('/api/v1/get-data', async (req, res) => {
    try {
        const result = await breaker.fire();
        res.json(result);
    } catch (error) {
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

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Service A running on port ${PORT}`);
});
