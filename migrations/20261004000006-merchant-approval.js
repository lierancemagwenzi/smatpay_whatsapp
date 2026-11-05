'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // When the merchant asked Smatpay to approve the business; the bot watches for the answer.
        await queryInterface.addColumn('users', 'merchant_approval_requested_at', {type: Sequelize.DATE});
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('users', 'merchant_approval_requested_at');
    },
};
