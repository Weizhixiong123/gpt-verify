// Preserve the website's row order; price_asc is its price ranking, not a success ranking.
const URL = 'https://sms.fur.li/api/compare?mode=recommended&country=&provider=&status=&sort=price_asc&summary=1';
const SLUGS = {
  NG: 'nigeria', BD: 'bangladesh', SA: 'saudiarabia', BR: 'brazil',
  CA: 'canada', CO: 'colombia', CM: 'cameroon', AO: 'angola',
  GH: 'ghana', TH: 'thailand', PL: 'poland', US: 'usa',
  GB: 'england', RU: 'russia', VN: 'vietnam', LA: 'laos', KR: 'southkorea',
};

async function fetchOrder(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`推荐国家接口 HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.rows) || !data.rows.length) throw new Error('推荐国家列表为空或格式错误');
  const countries = [];
  for (const row of data.rows) {
    const country = SLUGS[row.countryIso2] ||
      (typeof row.countryNameEn === 'string' ? row.countryNameEn.toLowerCase().replace(/[^a-z]/g, '') : '');
    if (country && !countries.includes(country)) countries.push(country);
  }
  if (!countries.length) throw new Error('推荐国家列表没有可识别的国家');
  return countries;
}

module.exports = { URL, fetchOrder };
