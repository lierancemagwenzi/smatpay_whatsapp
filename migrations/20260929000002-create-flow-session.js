'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('flow_sessions', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            token_hash: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            phone: {type: Sequelize.STRING, allowNull: false},
            flow: {type: Sequelize.STRING, allowNull: false},
            purpose: Sequelize.STRING,
            status: {type: Sequelize.STRING, allowNull: false, defaultValue: 'open'},
            data: Sequelize.TEXT,
            expires_at: {type: Sequelize.DATE, allowNull: false},
            completed_at: Sequelize.DATE,
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('flow_sessions', ['phone']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('flow_sessions');
    },
};
