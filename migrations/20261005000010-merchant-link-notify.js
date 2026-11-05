'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // Payment link payments made before this are not announced (set on the first check).
        await queryInterface.addColumn('users', 'merchant_link_notify_since', {type: Sequelize.DATE});
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('users', 'merchant_link_notify_since');
    },
};
