import { defineComponent, h } from 'vue'

type Shape = [string, Record<string, string | number>]
function icon(name: string, shapes: Shape[]) {
  return defineComponent({
    name,
    props: { size: { type: [Number, String], default: 24 }, strokeWidth: { type: [Number, String], default: 1.7 } },
    setup: props => () => h('svg', { width: props.size, height: props.size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': props.strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, shapes.map(([tag, attrs]) => h(tag, attrs))),
  })
}
const path = (d: string): Shape => ['path', { d }]
const circle = (cx: number, cy: number, r: number): Shape => ['circle', { cx, cy, r }]
const rect = (x: number, y: number, width: number, height: number, rx = 2): Shape => ['rect', { x, y, width, height, rx }]
export const Leaf = icon('Leaf', [path('M20 3C8 2 3 7 4 14c1 6 10 8 14 2 2-3 2-8 2-13Z'), path('M3 21 15 9M8 16v-5m4 1h5')])
export const Sprout = icon('Sprout', [path('M12 21V11M12 16C5 16 3 12 3 7c7-1 10 3 9 9ZM12 12c0-6 3-10 9-9 0 6-3 10-9 9Z')])
export const Dna = icon('Dna', [path('M6 3c0 9 12 9 12 18M18 3c0 9-12 9-12 18M7 5h10M8 8h8M8 16h8M7 19h10')])
export const HeartPulse = icon('HeartPulse', [path('M20 13c5-6-3-13-8-7C7 0-1 7 4 13l8 8 8-8ZM2 12h5l2-4 4 8 2-4h7')])
export const Mountain = icon('Mountain', [path('m2 20 8-16 5 10 3-5 4 11H2ZM7 10l3 3 3-3')])
export const ArrowRight = icon('ArrowRight', [path('M4 12h16m-6-6 6 6-6 6')])
export const ArrowLeft = icon('ArrowLeft', [path('M20 12H4m6-6-6 6 6 6')])
export const ArrowUpRight = icon('ArrowUpRight', [path('M6 18 18 6M6 6h12v12')])
export const ChevronDown = icon('ChevronDown', [path('m6 9 6 6 6-6')])
export const Check = icon('Check', [path('m5 12 4 4L19 6')])
export const CheckCheck = icon('CheckCheck', [path('m2 12 4 4L16 6m-3 10 9-10')])
export const X = icon('X', [path('m6 6 12 12M6 18 18 6')])
export const Plus = icon('Plus', [path('M12 4v16M4 12h16')])
export const Menu = icon('Menu', [path('M4 6h16M4 12h16M4 18h16')])
export const LayoutDashboard = icon('LayoutDashboard', [rect(3,3,7,9),rect(14,3,7,5),rect(3,16,7,5),rect(14,12,7,9)])
export const BookOpen = icon('BookOpen', [path('M12 5C9 3 6 3 2 4v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Zm0 0v15')])
export const Users = icon('Users', [circle(9,7,3),path('M3 21v-4a6 6 0 0 1 12 0v4M16 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v2')])
export const Trophy = icon('Trophy', [path('M7 3h10v6a5 5 0 0 1-10 0V3ZM7 5H3v3c0 3 2 4 5 4m9-7h4v3c0 3-2 4-5 4m-4 2v6m-5 1h10')])
export const ChartNoAxesCombined = icon('ChartNoAxesCombined', [path('M4 20v-5m5 5V9m5 11v-7m5 7V4M3 11l6-6 5 3 7-7')])
export const PencilRuler = icon('PencilRuler', [path('m3 17 12-12 4 4L7 21H3v-4ZM13 7l4 4M4 3l17 17-3 3L1 6l3-3Zm3 3L5 8m6 2-2 2m6 2-2 2')])
export const ShieldCheck = icon('ShieldCheck', [path('M12 2 3 6v6c0 6 9 10 9 10s9-4 9-10V6l-9-4ZM8 12l3 3 5-6')])
export const LogOut = icon('LogOut', [path('M9 4H4v16h5M9 12h12m-5-5 5 5-5 5')])
export const Target = icon('Target', [circle(12,12,9),circle(12,12,5),circle(12,12,1)])
export const Zap = icon('Zap', [path('m13 2-9 12h7l-1 8L21 9h-8V2Z')])
export const Clock3 = icon('Clock3', [circle(12,12,9),path('M12 6v6h5')])
export const Sparkles = icon('Sparkles', [path('m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM3 2v4M1 4h4m15 14v4m-2-2h4')])
export const FlaskConical = icon('FlaskConical', [path('M9 3h6M10 3v6L4 19c-1 2 1 2 2 2h12c1 0 3 0 2-2L14 9V3M7 14h10')])
export const Eye = icon('Eye', [path('M2 12S6 5 12 5s10 7 10 7-4 7-10 7S2 12 2 12Z'),circle(12,12,3)])
export const EyeOff = icon('EyeOff', [path('M3 3 21 21M9 5a11 11 0 0 1 13 7l-3 4M6 6a16 16 0 0 0-4 6s4 7 10 7a11 11 0 0 0 5-1M10 10a3 3 0 0 0 4 4')])
export const Medal = icon('Medal', [circle(12,15,6),path('m7 11-4-9h5l4 7 4-7h5l-4 9M12 12v6m-2-3h4')])
export const CircleCheck = icon('CircleCheck', [circle(12,12,9),path('m8 12 3 3 5-6')])
export const CheckCircle2 = CircleCheck
export const CircleHelp = icon('CircleHelp', [circle(12,12,9),path('M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01')])
export const Copy = icon('Copy', [rect(8,8,13,13),path('M16 8V3H3v13h5')])
export const Crown = icon('Crown', [path('m3 6 4 5 5-8 5 8 4-5-2 13H5L3 6ZM5 22h14')])
export const DoorOpen = icon('DoorOpen', [path('M3 21h18M5 21V3h14v18M5 3l10 3v15m-4-8h.01')])
export const Download = icon('Download', [path('M12 3v12m-5-5 5 5 5-5M3 15v6h18v-6')])
export const Upload = icon('Upload', [path('M12 16V3m-5 5 5-5 5 5M3 15v6h18v-6')])
export const FileCheck2 = icon('FileCheck2', [path('M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 15l3 3 5-6')])
export const FilePlus2 = icon('FilePlus2', [path('M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 15h8m-4-4v8')])
export const Flag = icon('Flag', [path('M4 22V3c6-4 10 4 16 0v12c-6 4-10-4-16 0')])
export const ImagePlus = icon('ImagePlus', [rect(3,3,18,18),circle(8,8,2),path('m3 17 6-5 4 4 4-3 4 4M18 1v6m-3-3h6')])
export const Layers3 = icon('Layers3', [path('m12 2 10 5-10 5L2 7l10-5ZM2 12l10 5 10-5M2 17l10 5 10-5')])
export const Lightbulb = icon('Lightbulb', [path('M8 16c0-3-3-3-3-7a7 7 0 0 1 14 0c0 4-3 4-3 7H8Zm0 3h8m-6 3h4')])
export const LoaderCircle = icon('LoaderCircle', [path('M21 12a9 9 0 1 1-9-9')])
export const Pencil = icon('Pencil', [path('m3 17 13-13 4 4L7 21H3v-4ZM14 6l4 4')])
export const Radio = icon('Radio', [circle(12,12,2),path('M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16')])
export const RotateCcw = icon('RotateCcw', [path('M3 10a9 9 0 1 1 1 8M3 3v7h7')])
export const Search = icon('Search', [circle(10,10,7),path('m15 15 6 6')])
export const Send = icon('Send', [path('m2 3 20 9-20 9 4-9-4-9Zm4 9h16')])
export const Trash2 = icon('Trash2', [path('M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7')])
export const Wifi = icon('Wifi', [path('M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0M12 20h.01')])
export const WifiOff = icon('WifiOff', [path('M2 2 22 22M2 8a16 16 0 0 1 3-2m4-2a16 16 0 0 1 13 4M5 12a11 11 0 0 1 4-2m5 0a11 11 0 0 1 5 2M8 16a6 6 0 0 1 8 0M12 20h.01')])
