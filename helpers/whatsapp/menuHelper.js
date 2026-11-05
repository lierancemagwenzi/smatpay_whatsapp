const messagingHelper = require('./messagingHelper');
const planeHelper = require('../smatpay/planeHelper');
const sessionHelper = require('../smatpay/sessionHelper');

const flow = 'main_menu';

module.exports = {
    sendMainMenu: async function (sender, user) {
        const guest = sessionHelper.isGuest(user);
        const name = user?.first_name ? `, ${user.first_name}` : '';
        await messagingHelper.sendList(
            sender,
            `What would you like to do${name}?`,
            'Menu',
            [
                {
                    title: 'Pay and buy',
                    rows: [
                        {id: 'MENU_PAY', title: 'Pay a merchant', description: 'With a Smatpay code or link'},
                        {id: 'MENU_AIRTIME', title: 'Buy airtime', description: 'Econet and NetOne'},
                        {id: 'MENU_DATA', title: 'Buy data', description: 'NetOne data bundles'},
                        {id: 'MENU_ELECTRICITY', title: 'Buy electricity', description: 'ZESA tokens'},
                        {id: 'MENU_WATER', title: 'Pay for water', description: 'Council water tokens'},
                    ],
                },
                {
                    title: 'Account',
                    rows: [
                        guest
                            ? {id: 'GUEST_SIGNUP', title: 'Create account', description: 'Keep cards and see your history'}
                            : {id: 'MENU_TRANSACTIONS', title: 'Transactions', description: 'Your recent payments'},
                        guest
                            ? {id: 'MENU_ACCOUNT', title: 'Guest', description: 'Sign in, or leave guest mode'}
                            : {id: 'MENU_ACCOUNT', title: 'My account', description: 'Details, PIN and sign out'},
                        {id: 'MENU_HELP', title: 'Help', description: 'Contact Smatpay support'},
                        {id: 'USER_TYPE_MERCHANT', title: 'Business account', description: 'Take payments as a Smatpay merchant'},
                    ],
                },
            ],
            `Smatpay${guest ? ' guest' : ''}${planeHelper.isSandbox() ? ' (sandbox)' : ''}`
        );
        await messagingHelper.setStep(sender, flow, {current_flow: flow});
    },

    sendComingSoon: async function (sender, feature) {
        await messagingHelper.sendButtons(
            sender,
            `${feature} on WhatsApp is coming soon. You can already do it in the Smatpay app.`,
            [{id: 'MAIN_MENU', title: 'Main menu'}]
        );
    },

    sendAccount: async function (sender, user) {
        if (sessionHelper.isGuest(user)) {
            await messagingHelper.sendButtons(sender,
                '*Guest*\nYou’re buying without an account. Create one, or sign in, to keep your cards and see your history.', [
                    {id: 'GUEST_SIGNUP', title: 'Create account'},
                    {id: 'GUEST_LOGIN', title: 'Sign in'},
                    {id: 'SIGN_OUT', title: 'Leave guest mode'},
                ]);
            return messagingHelper.setStep(sender, 'account');
        }
        const lines = [
            '*My account*',
            `${user.first_name || ''} ${user.last_name || ''}`.trim(),
            user.email,
            user.customer_number ? `Customer number: ${user.customer_number}` : null,
        ].filter(Boolean);
        await messagingHelper.sendButtons(sender, lines.join('\n'), [
            {id: 'CHANGE_PIN', title: 'Change PIN'},
            {id: 'SIGN_OUT', title: 'Sign out'},
            {id: 'MAIN_MENU', title: 'Main menu'},
        ]);
        await messagingHelper.setStep(sender, 'account');
    },

    sendHelp: async function (sender) {
        const phone = process.env.SUPPORT_PHONE;
        await messagingHelper.sendButtons(
            sender,
            `Need help? Call or WhatsApp Smatpay support on ${phone}.`,
            [{id: 'MAIN_MENU', title: 'Main menu'}]
        );
    },
};
