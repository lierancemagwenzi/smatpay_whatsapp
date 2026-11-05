'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // A number signed in as a merchant (user_type 'merchant'). Keys and token are encrypted.
        await queryInterface.addColumn('users', 'merchant_user_id', {type: Sequelize.BIGINT});
        await queryInterface.addColumn('users', 'merchant_account_id', {type: Sequelize.BIGINT});
        await queryInterface.addColumn('users', 'merchant_id', {type: Sequelize.STRING});
        await queryInterface.addColumn('users', 'merchant_name', {type: Sequelize.STRING});
        await queryInterface.addColumn('users', 'merchant_approved', {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false});
        await queryInterface.addColumn('users', 'merchant_keys_enc', {type: Sequelize.TEXT});
        await queryInterface.addColumn('users', 'merchant_token_enc', {type: Sequelize.TEXT});
        await queryInterface.addColumn('users', 'merchant_token_expires_at', {type: Sequelize.DATE});
    },

    async down(queryInterface) {
        for (const column of ['merchant_token_expires_at', 'merchant_token_enc', 'merchant_keys_enc', 'merchant_approved',
            'merchant_name', 'merchant_id', 'merchant_account_id', 'merchant_user_id']) {
            await queryInterface.removeColumn('users', column);
        }
    },
};
