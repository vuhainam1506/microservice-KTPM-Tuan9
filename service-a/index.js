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
        // Đảm bảo lỗi được throw để Circuit Breaker có thể đếm
        throw new Error('ECONNREFUSED');
    }
}, {
    timeout: 3000, // 3 seconds
    errorThresholdPercentage: 1, // Chỉ cần 1% lỗi là trip
    resetTimeout: 10000, // 10 seconds to reset
    volumeThreshold: 3, // Số lần tối thiểu trước khi có thể trip
    rollingCountTimeout: 10000, // 10 second window
    rollingCountBuckets: 10, // 10 buckets of 1 second each
});

// Event listeners
breaker.on('open', () => {
    console.log('Circuit Breaker is now OPEN - Service is blocked');
    console.log('Current stats:', breaker.stats);
});

breaker.on('halfOpen', () => {
    console.log('Circuit Breaker is now HALF_OPEN - Testing service availability');
});

breaker.on('close', () => {
    console.log('Circuit Breaker is now CLOSED - Service is operational');
});

breaker.on('failure', (error) => {
    console.log('Call failed:', error.message);
    console.log('Current failure count:', breaker.stats.failures);
});

breaker.on('reject', () => {
    console.log('Request rejected (circuit is open)');
});

breaker.on('success', () => {
    console.log('Request succeeded');
    console.log('Current success count:', breaker.stats.successes);
});

// API endpoint
app.get('/api/service-a', async (req, res) => {
    try {
        const result = await breaker.fire();
        res.json(result);
    } catch (error) {
        // Kiểm tra nếu circuit breaker đang mở
        if (breaker.opened) {
            return res.status(503).json({
                message: 'Circuit Breaker is OPEN! Too many failures, service is blocked.',
                error: error.message,
                circuitBreakerState: {
                    state: breaker.status.state,
                    stats: breaker.stats
                }
            });
        }

        res.status(503).json({
            message: 'Service B is down! Circuit Breaker is active.',
            error: error.message,
            circuitBreakerState: {
                state: breaker.status.state,
                stats: breaker.stats
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
            opened: breaker.opened
        }
    });
});

// Fallback function khi circuit breaker mở
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


