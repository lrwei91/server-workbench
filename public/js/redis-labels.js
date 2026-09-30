const STEP_NAMES = Object.freeze({ First: '第一步', Second: '第二步', Third: '第三步', Fourth: '第四步', Fifth: '第五步' });
const GROUP_NAMES = Object.freeze({
  offerInsts: '销售品实例',
  offerProdInstRels: '销售品实例与产品实例关系',
  offerInstRels: '销售品实例关系',
  offerInstAttrs: '销售品实例属性',
  prodInsts: '产品实例',
  prodInstRels: '产品实例关系',
  prodInstAttrs: '产品实例属性',
  prodInstAcctRels: '产品实例与账户关系',
  accounts: '账户',
});

// 按 CPP 档案字段命名释义；原字段名始终保留，代码值不在这里推断成业务状态。
export const REDIS_FIELD_NAMES = Object.freeze({
  accNbr: '接入号码',
  account: '账号或账户标识',
  accountAreaGrade: '账户区域等级',
  accountId: '账户 ID',
  acctItemTypeGroupId: '账目类型组 ID',
  areaCode: '区域编码',
  areaId: '区域 ID',
  attrId: '属性 ID',
  attrValue: '属性值',
  attrValueId: '属性值 ID',
  beginRentTime: '起租时间',
  chargePrio: '收费优先级',
  chargeType: '收费类型',
  commonRegionId: '公共区域 ID',
  createDate: '创建时间',
  custId: '客户 ID',
  dcsIbsOfferType: 'DCS/IBS 销售品类型',
  dcsIbsProdType: 'DCS/IBS 产品类型',
  dcsStatusCd: 'DCS 状态代码',
  defAcctFlag: '默认账户标识',
  effDate: '生效时间',
  executetime: '执行时间',
  expDate: '失效时间',
  hisId: '历史记录 ID',
  messageStoreTime: '消息存储时间',
  offerProdInstRelId: '销售品实例与产品实例关系 ID',
  offerSubType: '销售品子类型',
  ownerCustId: '所属客户 ID',
  parentProdInstId: '父产品实例 ID',
  payCycle: '付费周期',
  payPrio: '支付优先级',
  paymentLimit: '支付限额',
  paymentLimitType: '支付限额类型',
  paymentModeCd: '付费方式代码',
  priority: '优先级',
  prodInstAId: 'A 端产品实例 ID',
  prodInstAcctId: '产品实例与账户关系 ID',
  prodInstAttrId: '产品实例属性 ID',
  prodInstId: '产品实例 ID',
  prodInstRelId: '产品实例关系 ID',
  prodInstZId: 'Z 端产品实例 ID',
  prodOfferId: '销售品 ID',
  prodOfferInstAttrId: '销售品实例属性 ID',
  prodOfferInstId: '销售品实例 ID',
  prodOfferInstRelId: '销售品实例关系 ID',
  productId: '产品 ID',
  productType: '产品类型',
  recUpdateDate: '记录更新时间',
  regionCd: '地区代码',
  regionCode: '地区编码',
  relaProdOfferInstId: '关系销售品实例 ID',
  relatedProdOfferInstId: '关联销售品实例 ID',
  relationTypeCd: '关系类型代码',
  roleCd: '角色代码',
  shardingId: '分片 ID',
  statusDate: '状态变更时间',
  stopRentTime: '停租时间',
  trialEffDate: '试用生效时间',
  trialExpDate: '试用失效时间',
  updateDate: '更新时间',
  yzfAccount: '翼支付账户',
});

const REDIS_TIME_FIELDS = new Set([
  'beginRentTime', 'createDate', 'effDate', 'executetime', 'expDate',
  'messageStoreTime', 'recUpdateDate', 'statusDate', 'stopRentTime',
  'trialEffDate', 'trialExpDate', 'updateDate',
]);

export function redisTimestampText(value, key) {
  if (!REDIS_TIME_FIELDS.has(key) || !['number', 'string'].includes(typeof value)) return null;
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) return null;
  const milliseconds = Number(raw);
  if (!Number.isSafeInteger(milliseconds)) return null;
  const date = new Date(milliseconds + 8 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return `${raw}（${date.toISOString().slice(0, 19).replace('T', ' ')} +08:00）`;
}

export function redisArchiveLabel(key, depth) {
  if (/^\d+$/.test(key)) return key;
  if (depth === 1) {
    const match = /^(offerInsts|offerProdInstRels|offerInstRels|offerInstAttrs|prodInsts|prodInstRels|prodInstAttrs)(First|Second|Third|Fourth|Fifth)Step$/.exec(key);
    const meaning = match ? `${GROUP_NAMES[match[1]]}（${STEP_NAMES[match[2]]}）` : GROUP_NAMES[key];
    return `${key} · ${meaning || '待确认分组含义'}`;
  }
  return `${key} · ${REDIS_FIELD_NAMES[key] || '待确认字段含义'}`;
}
