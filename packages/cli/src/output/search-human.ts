import { stripVTControlCharacters } from 'node:util';
import { type SearchReport, redactSensitiveString } from '@skillsmith/core';

/** Presentation escaping must never rewrite the provider identifiers in JSON. */
export const searchDisplayText = (value: string): string =>
  stripVTControlCharacters(redactSensitiveString(value)).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    ' ',
  );

export const renderSearchHuman = (
  report: SearchReport,
  selectedCatalogId: string | null = null,
): string => {
  const hits =
    selectedCatalogId === null
      ? report.results
      : report.results.filter((hit) => hit.catalogId === selectedCatalogId);
  const heading = `skills.sh search (experimental): ${searchDisplayText(report.query)}`;
  if (hits.length === 0) return `${heading}\nNo matching skills found.\n`;
  const rows = hits.map((hit, index) =>
    [
      `${index + 1}. ${searchDisplayText(hit.name)}`,
      `   Source: ${hit.source === null ? 'unknown' : searchDisplayText(hit.source)}`,
      ...(hit.installs === null ? [] : [`   Installs: ${hit.installs}`]),
      `   ${hit.url}`,
    ].join('\n'),
  );
  return `${heading}\n\n${rows.join('\n\n')}\n\n${report.returned} results returned (limit ${report.limit}), in provider order.\nVerification: not checked. Installation counts do not establish trust.\n`;
};
