'use strict';
const {Model} = require('sequelize');

/** A Smatpay VAS purchase started from WhatsApp, polled until it completes or fails. */
module.exports = (sequelize, DataTypes) => {
    class purchase extends Model {
    }

    purchase.init({
        phone: {type: DataTypes.STRING, allowNull: false},
        // 'vas' (airtime, electricity, water), 'pay' (a merchant payment), 'data', 'topup', 'request',
        // or 'link' (a payment received through a merchant's payment link, recorded once announced).
        kind: {type: DataTypes.STRING, allowNull: false, defaultValue: 'vas'},
        purchase_id: {type: DataTypes.STRING, allowNull: false, unique: true},
        biller: DataTypes.STRING,
        biller_name: DataTypes.STRING,
        account: DataTypes.STRING,
        amount: DataTypes.STRING,
        total: DataTypes.STRING,
        currency: DataTypes.STRING,
        payment_method: DataTypes.STRING,
        payment_msisdn: DataTypes.STRING,
        status: DataTypes.STRING,
        notified_status: DataTypes.STRING,
        last_checked_at: DataTypes.DATE,
    }, {
        sequelize,
        modelName: 'purchase',
        timestamps: true,
        underscored: true,
    });

    return purchase;
};
