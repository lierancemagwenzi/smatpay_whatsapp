'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // The business PIN, separate from the customer PIN on the same number (scrypt hash only).
        await queryInterface.addColumn('users', 'merchant_pin_hash', {type: Sequelize.STRING});
        await queryInterface.addColumn('users', 'merchant_pin_failed_attempts', {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0});
        await queryInterface.addColumn('users', 'merchant_pin_locked_until', {type: Sequelize.DATE});
    },

    async down(queryInterface) {
        for (const column of ['merchant_pin_locked_until', 'merchant_pin_failed_attempts', 'merchant_pin_hash']) {
            await queryInterface.removeColumn('users', column);
        }
    },
};
