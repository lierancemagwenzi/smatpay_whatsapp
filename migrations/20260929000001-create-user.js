'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('users', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            phone: {type: Sequelize.STRING, allowNull: false, unique: true},
            wa_name: Sequelize.STRING,
            user_type: Sequelize.STRING,
            current_flow: Sequelize.STRING,
            last_bot_message: Sequelize.STRING,
            last_bot_timestamp: Sequelize.DATE,
            last_user_timestamp: Sequelize.DATE,

            smatpay_user_id: Sequelize.BIGINT,
            email: Sequelize.STRING,
            first_name: Sequelize.STRING,
            last_name: Sequelize.STRING,
            customer_number: Sequelize.STRING,
            activation_activated: {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false},

            access_token_enc: Sequelize.TEXT,
            access_token_expires_at: Sequelize.DATE,
            refresh_token_enc: Sequelize.TEXT,
            refresh_token_expires_at: Sequelize.DATE,

            pin_hash: Sequelize.STRING,

            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('users', ['refresh_token_expires_at']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('users');
    },
};
