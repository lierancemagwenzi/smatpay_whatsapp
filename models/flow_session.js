'use strict';
const {Model} = require('sequelize');

/**
 * A WhatsApp Flow sent to a user. Flow endpoint requests carry only the flow_token, so this
 * row is how we know whose form it is. Only the token's SHA-256 is stored.
 */
module.exports = (sequelize, DataTypes) => {
    class flow_session extends Model {
    }

    flow_session.init({
        token_hash: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        phone: {type: DataTypes.STRING, allowNull: false},
        flow: {type: DataTypes.STRING, allowNull: false},
        purpose: DataTypes.STRING,
        status: {type: DataTypes.STRING, allowNull: false, defaultValue: 'open'},
        // TEXT rather than JSON: MariaDB's JSON is LONGTEXT and comes back as a string.
        data: {
            type: DataTypes.TEXT,
            get() {
                const raw = this.getDataValue('data');
                return raw ? JSON.parse(raw) : {};
            },
            set(value) {
                this.setDataValue('data', value == null ? null : JSON.stringify(value));
            },
        },
        expires_at: {type: DataTypes.DATE, allowNull: false},
        completed_at: DataTypes.DATE,
    }, {
        sequelize,
        modelName: 'flow_session',
        timestamps: true,
        underscored: true,
    });

    return flow_session;
};
