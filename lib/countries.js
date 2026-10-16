// 5SIM 国家英文名 → 中文名
const ZH = {
  afghanistan: '阿富汗', albania: '阿尔巴尼亚', algeria: '阿尔及利亚', argentina: '阿根廷', armenia: '亚美尼亚',
  australia: '澳大利亚', austria: '奥地利', azerbaijan: '阿塞拜疆', bahrain: '巴林', bangladesh: '孟加拉国',
  barbados: '巴巴多斯', belgium: '比利时', benin: '贝宁', bolivia: '玻利维亚', botswana: '博茨瓦纳', brazil: '巴西',
  bulgaria: '保加利亚', burkinafaso: '布基纳法索', burundi: '布隆迪', cambodia: '柬埔寨', cameroon: '喀麦隆',
  canada: '加拿大', capeverde: '佛得角', chile: '智利', colombia: '哥伦比亚', congo: '刚果', costarica: '哥斯达黎加',
  croatia: '克罗地亚', cyprus: '塞浦路斯', czech: '捷克', denmark: '丹麦', ecuador: '厄瓜多尔', egypt: '埃及',
  england: '英国', equatorialguinea: '赤道几内亚', estonia: '爱沙尼亚', ethiopia: '埃塞俄比亚', finland: '芬兰',
  france: '法国', gabon: '加蓬', gambia: '冈比亚', georgia: '格鲁吉亚', germany: '德国', ghana: '加纳', greece: '希腊',
  guatemala: '危地马拉', guinea: '几内亚', guyana: '圭亚那', haiti: '海地', honduras: '洪都拉斯', hongkong: '中国香港',
  india: '印度', indonesia: '印度尼西亚', ireland: '爱尔兰', israel: '以色列', italy: '意大利', jamaica: '牙买加',
  japan: '日本', jordan: '约旦', kazakhstan: '哈萨克斯坦', kenya: '肯尼亚', kuwait: '科威特', kyrgyzstan: '吉尔吉斯斯坦',
  laos: '老挝', latvia: '拉脱维亚', lesotho: '莱索托', liberia: '利比里亚', lithuania: '立陶宛', luxembourg: '卢森堡',
  madagascar: '马达加斯加', malawi: '马拉维', malaysia: '马来西亚', maldives: '马尔代夫', mauritania: '毛里塔尼亚',
  mauritius: '毛里求斯', mexico: '墨西哥', moldova: '摩尔多瓦', mongolia: '蒙古', montenegro: '黑山', morocco: '摩洛哥',
  mozambique: '莫桑比克', myanmar: '缅甸', namibia: '纳米比亚', nepal: '尼泊尔', netherlands: '荷兰',
  nicaragua: '尼加拉瓜', nigeria: '尼日利亚', northmacedonia: '北马其顿', norway: '挪威', pakistan: '巴基斯坦',
  panama: '巴拿马', paraguay: '巴拉圭', peru: '秘鲁', philippines: '菲律宾', poland: '波兰', portugal: '葡萄牙',
  romania: '罗马尼亚', russia: '俄罗斯', saintlucia: '圣卢西亚', salvador: '萨尔瓦多', saudiarabia: '沙特阿拉伯',
  senegal: '塞内加尔', serbia: '塞尔维亚', sierraleone: '塞拉利昂', slovakia: '斯洛伐克', slovenia: '斯洛文尼亚',
  southafrica: '南非', spain: '西班牙', srilanka: '斯里兰卡', suriname: '苏里南', swaziland: '斯威士兰', sweden: '瑞典',
  taiwan: '中国台湾', tajikistan: '塔吉克斯坦', tanzania: '坦桑尼亚', thailand: '泰国', togo: '多哥', tunisia: '突尼斯',
  turkey: '土耳其', uganda: '乌干达', ukraine: '乌克兰', usa: '美国', uzbekistan: '乌兹别克斯坦', venezuela: '委内瑞拉',
  vietnam: '越南', zambia: '赞比亚',
};

const countryName = (slug) => ZH[slug] || slug || '';

// 国际区号（不带 +）
const DIAL = {
  afghanistan: '93', albania: '355', algeria: '213', argentina: '54', armenia: '374', australia: '61', austria: '43',
  azerbaijan: '994', bahrain: '973', bangladesh: '880', barbados: '1', belgium: '32', benin: '229', bolivia: '591',
  botswana: '267', brazil: '55', bulgaria: '359', burkinafaso: '226', burundi: '257', cambodia: '855', cameroon: '237',
  canada: '1', capeverde: '238', chile: '56', colombia: '57', congo: ['243', '242'], costarica: '506', croatia: '385',
  cyprus: '357', czech: '420', denmark: '45', ecuador: '593', egypt: '20', england: '44', equatorialguinea: '240',
  estonia: '372', ethiopia: '251', finland: '358', france: '33', gabon: '241', gambia: '220', georgia: '995',
  germany: '49', ghana: '233', greece: '30', guatemala: '502', guinea: '224', guyana: '592', haiti: '509',
  honduras: '504', hongkong: '852', india: '91', indonesia: '62', ireland: '353', israel: '972', italy: '39',
  jamaica: '1', japan: '81', jordan: '962', kazakhstan: '7', kenya: '254', kuwait: '965', kyrgyzstan: '996',
  laos: '856', latvia: '371', lesotho: '266', liberia: '231', lithuania: '370', luxembourg: '352', madagascar: '261',
  malawi: '265', malaysia: '60', maldives: '960', mauritania: '222', mauritius: '230', mexico: '52', moldova: '373',
  mongolia: '976', montenegro: '382', morocco: '212', mozambique: '258', myanmar: '95', namibia: '264', nepal: '977',
  netherlands: '31', nicaragua: '505', nigeria: '234', northmacedonia: '389', norway: '47', pakistan: '92',
  panama: '507', paraguay: '595', peru: '51', philippines: '63', poland: '48', portugal: '351', romania: '40',
  russia: '7', saintlucia: '1', salvador: '503', saudiarabia: '966', senegal: '221', serbia: '381',
  sierraleone: '232', slovakia: '421', slovenia: '386', southafrica: '27', spain: '34', srilanka: '94',
  suriname: '597', swaziland: '268', sweden: '46', taiwan: '886', tajikistan: '992', tanzania: '255',
  thailand: '66', togo: '228', tunisia: '216', turkey: '90', uganda: '256', ukraine: '380', usa: '1',
  uzbekistan: '998', venezuela: '58', vietnam: '84', zambia: '260',
};

// "+306997752172" + greece → { dialCode: '+30', local: '6997752172' }；对不上区号时 dialCode 为 null
function splitPhone(phone, slug) {
  const digits = String(phone || '').replace(/\D/g, '');
  for (const code of [].concat(DIAL[slug] || [])) {
    if (digits.startsWith(code) && digits.length > code.length) {
      return { dialCode: `+${code}`, local: digits.slice(code.length) };
    }
  }
  return { dialCode: null, local: digits };
}

module.exports = { countryName, splitPhone };
