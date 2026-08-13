export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  code: string;
  drop_label: string;
  price: number;
  mrp: number | null;
  fabric: string;
  fit: string;
  care: string;
  description: string;
  category: string;
  badge: string | null;
  featured: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ProductColorRow {
  id: string;
  product_id: string;
  name: string;
  hex: string;
  images: string[];
  sort_order: number;
  created_at: string;
}

export interface ProductSizeRow {
  id: string;
  product_id: string;
  size_label: string;
  available: boolean;
}

export interface SizeChartRow {
  id: string;
  product_id: string;
  size_label: string;
  chest: number;
  length: number;
  shoulder: number;
  sort_order: number;
}

export interface HeroSlideRow {
  id: string;
  image_url: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  sort_order: number;
  active: boolean;
  created_at: string;
}

export interface CatalogProduct extends ProductRow {
  colors: ProductColorRow[];
  sizes: ProductSizeRow[];
  size_chart: SizeChartRow[];
}

export const SIZE_LABELS = ['S', 'M', 'L', 'XL', 'XXL'] as const;
export type SizeLabel = (typeof SIZE_LABELS)[number];

export const COLOR_PRESETS = [
  { name: 'Black', hex: '#0d0d0d' },
  { name: 'Brown', hex: '#5b3a29' },
  { name: 'Green', hex: '#2d4a2b' },
  { name: 'Maroon', hex: '#4a1620' },
] as const;
