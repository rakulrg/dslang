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
  color_id: string;
  size_label: string;
  available: boolean;
  stock: number;
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

export const SIZE_LABELS = ['M', 'L', 'XL'] as const;
