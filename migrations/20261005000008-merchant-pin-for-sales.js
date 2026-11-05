'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // Whether wallet sales ask for the business PIN (the business can turn it off).
        await queryInterface.addColumn('users', 'merchant_pin_for_sales', {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true});
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('users', 'merchant_pin_for_sales');
    },
};
