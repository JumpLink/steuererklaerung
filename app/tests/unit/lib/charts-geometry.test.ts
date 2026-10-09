import { describe, it, expect } from '@gjsify/unit';
import {
    groupedBarChart,
    linePath,
    sparklinePoints,
    plotPoints,
    categoryShares,
    niceTicks,
} from '@steuererklaerung/charts';

export default async () => {
    await describe('categoryShares', async () => {
        await it('scales relative to the largest magnitude', async () => {
            expect(categoryShares([100, 50, 25])).toStrictEqual([1, 0.5, 0.25]);
        });
        await it('uses absolute values', async () => {
            expect(categoryShares([-40, 20])).toStrictEqual([1, 0.5]);
        });
        await it('returns zeros for an all-zero input', async () => {
            expect(categoryShares([0, 0])).toStrictEqual([0, 0]);
        });
    });

    await describe('niceTicks', async () => {
        await it('produces round tick values across the range', async () => {
            expect(niceTicks(0, 100, 5)).toStrictEqual([0, 20, 40, 60, 80, 100]);
        });
        await it('pads a degenerate range', async () => {
            expect(niceTicks(5, 5, 4)).toStrictEqual([4, 4.5, 5, 5.5, 6]);
        });
    });

    await describe('groupedBarChart', async () => {
        const layout = groupedBarChart(['A', 'B'], [[10, 0], [5, 10]], { width: 100, height: 100 }, { gridLines: 3 });

        await it('emits one bar per (series, group)', async () => {
            expect(layout.bars.length).toBe(4);
        });
        await it('scales bars to the max value and the baseline', async () => {
            expect(layout.max).toBe(10);
            expect(layout.baseline).toBe(82);
            // series 0, group 0 = the full-height bar (value == max).
            expect(layout.bars[0]).toStrictEqual({
                x: 9.5,
                y: 0,
                width: 14,
                height: 82,
                series: 0,
                group: 0,
                value: 10,
            });
        });
        await it('gives a zero value no height', async () => {
            const zeroBar = layout.bars.find((b) => b.value === 0);
            expect(zeroBar?.height).toBe(0);
        });
        await it('places group labels centered under the baseline', async () => {
            expect(layout.labels[0]).toStrictEqual({ x: 25, y: 96, text: 'A' });
        });
        await it('spans gridlines from 0 to max', async () => {
            expect(layout.gridLines[0]).toStrictEqual({ y: 82, value: 0 });
            expect(layout.gridLines[2]).toStrictEqual({ y: 0, value: 10 });
        });
    });

    await describe('plotPoints / linePath / sparklinePoints', async () => {
        const box = { width: 100, height: 100 };
        const opts = { pad: 0 };

        await it('maps values to evenly-spaced points (y grows downward)', async () => {
            expect(plotPoints([0, 10], box, opts)).toStrictEqual([
                { x: 0, y: 100 },
                { x: 100, y: 0 },
            ]);
        });
        await it('builds line + area paths closed to the baseline', async () => {
            const p = linePath([0, 10], box, opts);
            expect(p.line).toBe('M0 100 L100 0');
            expect(p.area).toBe('M0 100 L100 0 L100 100 L0 100 Z');
        });
        await it('formats sparkline polyline points', async () => {
            expect(sparklinePoints([0, 10], box, opts)).toBe('0,100 100,0');
        });
        await it('centers a single point', async () => {
            expect(plotPoints([5], box, opts)).toStrictEqual([{ x: 50, y: 50 }]);
        });
    });
};
