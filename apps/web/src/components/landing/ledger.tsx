import type { Dictionary } from '../../content/vi';
import { Section, SectionHead } from './ui';

// What approved entries turn into: the subsidiary ledger of account 331 with a running balance, and the input VAT
// they feed, drawn to one scale.
export function Ledger({ dict }: { dict: Dictionary }) {
  const { ledger } = dict;
  const { vat } = ledger;
  const cell = 'px-4 py-2.5 align-baseline';
  const amount = `${cell} num text-right font-mono text-[13px] whitespace-nowrap`;
  return (
    <Section id="so-cai" labelledBy="ledger-title" tinted>
      <SectionHead id="ledger-title" title={ledger.title} lead={ledger.lead} />
      <div className="rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold">{ledger.tableTitle}</h3>
          <p className="text-xs text-subtle">{ledger.tableSub}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-subtle">
                {ledger.cols.map((col, i) => (
                  <th key={col} scope="col" className={`${cell} font-medium ${i >= 4 ? 'text-right' : ''}`}>
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line">
                <td className={`${cell} num`}>{ledger.opening.date}</td>
                <td className={cell} />
                <td className={`${cell} font-medium`}>{ledger.opening.label}</td>
                <td className={cell} />
                <td className={amount} />
                <td className={amount} />
                <td className={amount}>{ledger.opening.balance}</td>
              </tr>
              {ledger.rows.map((row, i) => (
                <tr key={i} className={`border-b border-line ${row.mark ? 'bg-accent-soft/50' : ''}`}>
                  <td className={`${cell} num`}>{row.date}</td>
                  <td className={`${cell} num font-mono text-[13px]`}>{row.doc}</td>
                  <td className={cell}>{row.desc}</td>
                  <td className={`${cell} num font-mono text-[13px]`}>{row.contra}</td>
                  <td className={amount}>{row.debit}</td>
                  <td className={amount}>{row.credit}</td>
                  <td className={amount}>{row.balance}</td>
                </tr>
              ))}
              <tr className="border-b border-line-strong/60">
                <td className={cell} />
                <td className={cell} />
                <td className={`${cell} font-medium`}>{ledger.totals.label}</td>
                <td className={cell} />
                <td className={`${amount} font-semibold`}>{ledger.totals.debit}</td>
                <td className={`${amount} font-semibold`}>{ledger.totals.credit}</td>
                <td className={amount} />
              </tr>
              <tr>
                <td className={`${cell} num`}>{ledger.closing.date}</td>
                <td className={cell} />
                <td className={`${cell} font-medium`}>{ledger.closing.label}</td>
                <td className={cell} />
                <td className={amount} />
                <td className={amount} />
                <td className={`${amount} font-semibold`}>
                  <span className="border-b-[3px] border-double border-fg pb-0.5">{ledger.closing.balance}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-xs text-subtle">{ledger.note}</p>

      <figure className="mt-10 grid gap-6 rounded-lg border border-line bg-surface p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-10">
        <figcaption className="min-w-0">
          <h3 className="text-sm font-semibold">{vat.title}</h3>
          <p className="text-xs text-subtle">{vat.sub}</p>
          <div className="mt-5 text-xs text-subtle">{vat.total[0]}</div>
          <div className="num mt-1 font-display text-3xl font-semibold tracking-[-0.01em]">{vat.total[1]}</div>
          <p className="mt-4 text-sm text-muted">{vat.pending}</p>
        </figcaption>
        <ul className="flex min-w-0 flex-col justify-center gap-4">
          {vat.rows.map((row) => (
            <li key={row.name} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{row.name}</div>
                <div className="truncate text-xs text-subtle">{row.sub}</div>
              </div>
              <div className="h-2.5 rounded-sm bg-surface-2">
                <div className="h-full min-w-1 rounded-sm bg-accent" style={{ width: row.width }} />
              </div>
              <span className="num w-[5.5rem] text-right font-mono text-[13px]">{row.amount}</span>
            </li>
          ))}
        </ul>
      </figure>
    </Section>
  );
}
