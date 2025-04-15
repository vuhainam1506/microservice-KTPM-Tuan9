const express = require('express');
const app = express();

app.get('/api/service-b', (req, res) => {
    res.json({
        message: "Hello from Service B",
        timestamp: new Date().toISOString()
    });
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`Service B running on port ${PORT}`);
});
