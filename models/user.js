'use strict';
const {Model} = require('sequelize');

/**
 * One row per WhatsApp number. Conversation state lives here, as in smatpay_whatsapp_api;
 * the Smatpay session (tokens) is encrypted and the password is never stored.
 */
module.exports = (sequelize, DataTypes) => {
    class user extends Model {
    }

    user.init({
        phone: {type: DataTypes.STRING, allowNull: false, unique: true},
        wa_name: DataTypes.STRING,
        user_type: DataTypes.STRING,
        current_flow: DataTypes.STRING,
        last_bot_message: DataTypes.STRING,
        last_bot_timestamp: DataTypes.DATE,
        last_user_timestamp: DataTypes.DATE,

        smatpay_user_id: DataTypes.BIGINT,
        email: DataTypes.STRING,
        first_name: DataTypes.STRING,
        last_name: DataTypes.STRING,
        customer_number: DataTypes.STRING,
        activation_activated: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},

        access_token_enc: DataTypes.TEXT,
        access_token_expires_at: DataTypes.DATE,
        refresh_token_enc: DataTypes.TEXT,
        guest_key_enc: DataTypes.TEXT,
        refresh_token_expires_at: DataTypes.DATE,

        pin_hash: DataTypes.STRING,
        pin_failed_attempts: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
        pin_locked_until: DataTypes.DATE,

        // Merchant side: the Smatpay merchant behind this number. Keys and token are encrypted.
        merchant_user_id: DataTypes.BIGINT,
        merchant_account_id: DataTypes.BIGINT,
        merchant_id: DataTypes.STRING,
        merchant_name: DataTypes.STRING,
        merchant_approved: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
        merchant_keys_enc: DataTypes.TEXT,
        merchant_token_enc: DataTypes.TEXT,
        merchant_token_expires_at: DataTypes.DATE,
        merchant_approval_requested_at: DataTypes.DATE,
        merchant_pin_hash: DataTypes.STRING,
        merchant_pin_failed_attempts: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
        merchant_pin_locked_until: DataTypes.DATE,
        merchant_pin_required: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true},
        merchant_link_notify_since: DataTypes.DATE,

        // What the user is in the middle of buying.
        draft: {
            type: DataTypes.TEXT,
            get() {
                const raw = this.getDataValue('draft');
                return raw ? JSON.parse(raw) : null;
            },
            set(value) {
                this.setDataValue('draft', value == null ? null : JSON.stringify(value));
            },
        },
    }, {
        sequelize,
        modelName: 'user',
        timestamps: true,
        underscored: true,
    });

    return user;
};
