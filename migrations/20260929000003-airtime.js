'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // What the user is in the middle of buying (JSON), and PIN lockout.
        await queryInterface.addColumn('users', 'draft', {type: Sequelize.TEXT});
        await queryInterface.addColumn('users', 'pin_failed_attempts', {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0});
        await queryInterface.addColumn('users', 'pin_locked_until', {type: Sequelize.DATE});

        // Purchases started from WhatsApp, followed until Smatpay says they're done.
        await queryInterface.createTable('purchases', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            phone: {type: Sequelize.STRING, allowNull: false},
            purchase_id: {type: Sequelize.STRING, allowNull: false, unique: true},
            biller: Sequelize.STRING,
            biller_name: Sequelize.STRING,
            account: Sequelize.STRING,
            amount: Sequelize.STRING,
            total: Sequelize.STRING,
            currency: Sequelize.STRING,
            payment_method: Sequelize.STRING,
            payment_msisdn: Sequelize.STRING,
            status: Sequelize.STRING,
            notified_status: Sequelize.STRING,
            last_checked_at: Sequelize.DATE,
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('purchases', ['status', 'created_at']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('purchases');
        await queryInterface.removeColumn('users', 'pin_locked_until');
        await queryInterface.removeColumn('users', 'pin_failed_attempts');
        await queryInterface.removeColumn('users', 'draft');
    },
};
