'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // 'vas' (airtime, electricity, water) or 'pay' (a merchant payment): they're followed on
        // different Smatpay endpoints.
        await queryInterface.addColumn('purchases', 'kind', {type: Sequelize.STRING, allowNull: false, defaultValue: 'vas'});
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('purchases', 'kind');
    },
};
