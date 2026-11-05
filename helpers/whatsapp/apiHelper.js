module.exports = {
    apiKey: function () {
        return process.env.D360_API_KEY;
    },

    baseUrl: function () {
        return (process.env.D360_BASE_URL || 'https://waba-v2.360dialog.io').replace(/\/+$/, '');
    },

    messagingEndpoint: function () {
        return `${this.baseUrl()}/messages`;
    },

    headers: function () {
        return {
            'D360-API-KEY': this.apiKey(),
            'Content-Type': 'application/json',
        };
    },
};
