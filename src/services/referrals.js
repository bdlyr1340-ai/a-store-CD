const {
  sequelize,
  User,
  Merchant,
  Referral,
  GiftClaim,
  BalanceTransaction,
  getSetting
} = require('../db');
const { createGiftOrder, fulfillOrder } = require('./orders');

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

async function getReferralSettings() {
  const [enabledRaw, rewardRaw, giftEnabledRaw, targetRaw, productRaw] = await Promise.all([
    getSetting('referral_enabled', 'true'),
    getSetting('referral_reward_amount', '0.05'),
    getSetting('referral_gift_enabled', 'true'),
    getSetting('referral_gift_target', '10'),
    getSetting('referral_gift_product_id', '')
  ]);

  const rewardAmount = Math.max(0, Number(rewardRaw || 0.05));
  const target = Math.max(1, Math.floor(Number(targetRaw || 10)));
  const giftProductId = Number(productRaw);

  return {
    enabled: boolValue(enabledRaw, true),
    rewardAmount: Number.isFinite(rewardAmount) ? rewardAmount : 0.05,
    giftEnabled: boolValue(giftEnabledRaw, true),
    target: Number.isFinite(target) ? target : 10,
    giftProductId: Number.isInteger(giftProductId) && giftProductId > 0 ? giftProductId : null
  };
}

async function setReferralCandidate(userId, referrerId) {
  const user = await User.findByPk(userId);
  if (!user || user.referredBy || user.referralProcessed) return false;
  const normalized = Number(referrerId);
  if (!Number.isFinite(normalized) || String(normalized) === String(userId)) return false;
  const referrer = await User.findByPk(normalized);
  if (!referrer || referrer.blocked) return false;
  user.referredBy = normalized;
  await user.save({ fields: ['referredBy'] });
  return true;
}

async function finalizeReferral(userId) {
  const settings = await getReferralSettings();
  if (!settings.enabled) return { processed: false, reason: 'DISABLED' };

  const transaction = await sequelize.transaction();
  try {
    const user = await User.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user || !user.verified || user.referralProcessed || !user.referredBy) {
      await transaction.rollback();
      return { processed: false, reason: 'NOT_ELIGIBLE' };
    }

    const referrer = await User.findByPk(user.referredBy, { transaction, lock: transaction.LOCK.UPDATE });
    if (!referrer || referrer.blocked || String(referrer.id) === String(user.id)) {
      user.referralProcessed = true;
      await user.save({ transaction, fields: ['referralProcessed'] });
      await transaction.commit();
      return { processed: false, reason: 'INVALID_REFERRER' };
    }

    const existing = await Referral.findOne({ where: { referredId: user.id }, transaction });
    if (existing) {
      user.referralProcessed = true;
      await user.save({ transaction, fields: ['referralProcessed'] });
      await transaction.commit();
      return { processed: false, reason: 'ALREADY_PROCESSED' };
    }

    referrer.balance = Number(referrer.balance || 0) + settings.rewardAmount;
    await referrer.save({ transaction, fields: ['balance'] });

    await Referral.create({
      referrerId: referrer.id,
      referredId: user.id,
      rewardAmount: settings.rewardAmount,
      status: 'rewarded'
    }, { transaction });

    await BalanceTransaction.create({
      userId: referrer.id,
      amount: settings.rewardAmount,
      type: 'referral_reward',
      txid: `REF-${user.id}`,
      caption: `Referral reward for user ${user.id}`,
      status: 'completed'
    }, { transaction });

    user.referralProcessed = true;
    await user.save({ transaction, fields: ['referralProcessed'] });

    const count = await Referral.count({
      where: { referrerId: referrer.id, status: 'rewarded' },
      transaction
    });

    await transaction.commit();
    return {
      processed: true,
      referrerId: referrer.id,
      referredId: user.id,
      rewardAmount: settings.rewardAmount,
      newBalance: Number(referrer.balance),
      count,
      settings
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function getReferralStats(userId) {
  const settings = await getReferralSettings();
  const count = await Referral.count({ where: { referrerId: userId, status: 'rewarded' } });
  const totalEarned = await Referral.sum('rewardAmount', { where: { referrerId: userId, status: 'rewarded' } }) || 0;
  const campaignKey = settings.giftProductId ? `${settings.giftProductId}:${settings.target}` : null;
  const claim = campaignKey
    ? await GiftClaim.findOne({ where: { userId, campaignKey } })
    : null;
  const product = settings.giftProductId ? await Merchant.findByPk(settings.giftProductId) : null;

  return {
    count,
    totalEarned: Number(totalEarned),
    settings,
    giftProduct: product,
    giftClaim: claim,
    eligibleForGift: Boolean(
      settings.enabled &&
      settings.giftEnabled &&
      settings.giftProductId &&
      count >= settings.target &&
      (!claim || claim.status === 'failed')
    )
  };
}

async function claimReferralGift(userId) {
  const stats = await getReferralStats(userId);
  if (!stats.settings.enabled || !stats.settings.giftEnabled) throw new Error('GIFT_DISABLED');
  if (!stats.settings.giftProductId) throw new Error('GIFT_PRODUCT_NOT_SET');
  if (stats.count < stats.settings.target) throw new Error('NOT_ENOUGH_REFERRALS');

  const campaignKey = `${stats.settings.giftProductId}:${stats.settings.target}`;
  const transaction = await sequelize.transaction();
  let claim;
  try {
    claim = await GiftClaim.findOne({
      where: { userId, campaignKey },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    if (claim?.status === 'completed') {
      await transaction.rollback();
      return { alreadyClaimed: true, claim };
    }
    if (claim?.status === 'pending') {
      const ageMs = Date.now() - new Date(claim.updatedAt || claim.createdAt || 0).getTime();
      if (ageMs < 5 * 60 * 1000) {
        await transaction.rollback();
        throw new Error('GIFT_IN_PROGRESS');
      }
      claim.status = 'failed';
      claim.error = 'Recovered stale pending claim';
      await claim.save({ transaction });
    }

    if (!claim) {
      claim = await GiftClaim.create({
        userId,
        campaignKey,
        merchantId: stats.settings.giftProductId,
        status: 'pending'
      }, { transaction });
    } else {
      claim.status = 'pending';
      claim.error = null;
      await claim.save({ transaction });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  try {
    const order = await createGiftOrder({
      userId,
      merchantId: stats.settings.giftProductId
    });
    const fulfillment = await fulfillOrder(order.id, { paymentRef: `referral-gift:${claim.id}` });
    claim.status = 'completed';
    claim.orderId = order.id;
    claim.error = null;
    await claim.save();
    return { alreadyClaimed: false, claim, fulfillment, product: stats.giftProduct };
  } catch (error) {
    claim.status = 'failed';
    claim.error = error.message;
    await claim.save();
    throw error;
  }
}

module.exports = {
  getReferralSettings,
  setReferralCandidate,
  finalizeReferral,
  getReferralStats,
  claimReferralGift
};
