export interface ProductColor {
  name: string;
  hex: string;
  images: string[];
}

export interface Product {
  slug: string;
  name: string;
  code: string;
  drop: string;
  price: number;
  mrp: number | null;
  colors: ProductColor[];
  sizes: string[];
  fabric: string;
  fit: string;
  care: string;
  description: string;
  category: 'tee' | 'hoodie' | 'drop';
  badge?: string;
  featured?: boolean;
}

export const products: Product[] = [
  {
    slug: 'fallen-halo-tee',
    name: 'Fallen Halo Tee',
    code: 'DSL-FH-01',
    drop: 'Drop 01',
    price: 899,
    mrp: 1299,
    fabric: 'Premium Combed Cotton',
    fit: 'Boxy Fit',
    care: 'Cold wash inside out. Do not bleach. Iron print inside out. Hang dry.',
    description:
      'The Fallen Halo graphic on premium cotton with a boxy cut.',
    category: 'tee',
    badge: 'Best Seller',
    featured: true,
    colors: [
      {
        name: 'Black',
        hex: '#0d0d0d',
        images: [
          'https://images.pexels.com/photos/37043496/pexels-photo-37043496.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/13020610/pexels-photo-13020610.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/3290886/pexels-photo-3290886.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
        ],
      },
      {
        name: 'White',
        hex: '#ededed',
        images: [
          'https://images.pexels.com/photos/18856590/pexels-photo-18856590.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/7643904/pexels-photo-7643904.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/12922554/pexels-photo-12922554.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
        ],
      },
    ],
    sizes: ['M', 'L', 'XL', 'XXL'],
  },
  {
    slug: 'uncontrol-tee',
    name: 'Uncontrol Tee',
    code: 'DSL-UN-02',
    drop: 'Drop 01',
    price: 899,
    mrp: 1299,
    fabric: 'Premium Combed Cotton',
    fit: 'Boxy Fit',
    care: 'Cold wash inside out. Do not bleach. Iron print inside out. Hang dry.',
    description:
      'Bold front print with a dropped shoulder silhouette that drapes clean.',
    category: 'tee',
    badge: 'New',
    featured: true,
    colors: [
      {
        name: 'Black',
        hex: '#0d0d0d',
        images: [
          'https://images.pexels.com/photos/15984691/pexels-photo-15984691.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/30186079/pexels-photo-30186079.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/18403112/pexels-photo-18403112.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
        ],
      },
      {
        name: 'Sand',
        hex: '#b8a888',
        images: [
          'https://images.pexels.com/photos/15258903/pexels-photo-15258903.png?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/15258905/pexels-photo-15258905.png?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/15693987/pexels-photo-15693987.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
        ],
      },
    ],
    sizes: ['M', 'L', 'XL', 'XXL'],
  },
  {
    slug: 'sever-tee',
    name: 'Sever Tee',
    code: 'DSL-SV-03',
    drop: 'Drop 01',
    price: 949,
    mrp: 1399,
    fabric: 'Premium Combed Cotton',
    fit: 'Boxy Fit',
    care: 'Cold wash inside out. Do not bleach. Iron print inside out. Hang dry.',
    description:
      'Minimal back print, clean front chest hit, sharp drape.',
    category: 'tee',
    badge: 'Limited Run',
    featured: true,
    colors: [
      {
        name: 'Black',
        hex: '#0d0d0d',
        images: [
          'https://images.pexels.com/photos/16649942/pexels-photo-16649942.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/5975344/pexels-photo-5975344.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/16781290/pexels-photo-16781290.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
        ],
      },
      {
        name: 'Wine',
        hex: '#4a1620',
        images: [
          'https://images.pexels.com/photos/13046261/pexels-photo-13046261.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/2315347/pexels-photo-2315347.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
          'https://images.pexels.com/photos/12644737/pexels-photo-12644737.jpeg?auto=compress&cs=tinysrgb&h=900&w=700',
        ],
      },
    ],
    sizes: ['M', 'L', 'XL', 'XXL'],
  },
];

export const getProduct = (slug: string): Product | undefined =>
  products.find((p) => p.slug === slug);

export interface WhatsAppOrder {
  name: string;
  code: string;
  color: string;
  size: string;
  quantity: number;
  price: number;
}

export const WHATSAPP_NUMBER = '919944676178';
export const INSTAGRAM_URL = 'https://instagram.com/dslang.in';
export const EMAIL = 'hello@dslang.in';

export function buildWhatsAppUrl(order: WhatsAppOrder): string {
  const total = order.price * order.quantity;
  const message =
`Hi DSLANG! I'd like to order:

Product: ${order.name}
Code: ${order.code}
Color: ${order.color}
Size: ${order.size}
Qty: ${order.quantity}
Price: ₹${order.price} x ${order.quantity} = ₹${total}

Please confirm availability and delivery details.`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export function buildWhatsAppGeneralUrl(message: string): string {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export function formatPrice(n: number): string {
  return `₹${n.toLocaleString('en-IN')}`;
}
