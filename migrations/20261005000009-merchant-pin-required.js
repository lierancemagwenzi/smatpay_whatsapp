'use strict';

module.exports = {
    async up(queryInterface) {
        // The switch now covers every PIN check, not just sales.
        await queryInterface.renameColumn('users', 'merchant_pin_for_sales', 'merchant_pin_required');
    },

    async down(queryInterface) {
        await queryInterface.renameColumn('users', 'merchant_pin_required', 'merchant_pin_for_sales');
    },
};
