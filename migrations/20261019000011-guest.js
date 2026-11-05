'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // Guest checkout: the number's guest "device key" (encrypted). The same key always gets the
        // same Smatpay guest number, so receipts survive a new guest token.
        await queryInterface.addColumn('users', 'guest_key_enc', {type: Sequelize.TEXT});
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('users', 'guest_key_enc');
    },
};
