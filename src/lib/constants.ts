import {
  LayoutDashboard,
  PhoneCall,
  History,
  PhoneMissed,
  MessageSquare,
  Users,
  Mic,
  ShieldCheck,
  Settings,
  CreditCard,
  Zap,
  Receipt,
  Hash,
  Sparkles,
  GitFork,
  Voicemail as VoicemailIcon,
} from 'lucide-react';

export interface NavItem {
  name: string;
  href: string;
  icon: any;
  badge?: string | number;
  category: 'main' | 'numbers' | 'billing' | 'admin';
}

export const NAVIGATION_ITEMS: NavItem[] = [
  // Communication Category
  {
    name: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    category: 'main',
  },
  {
    name: 'Phone',
    href: '/phone',
    icon: PhoneCall,
    category: 'main',
  },
  {
    name: 'Calls',
    href: '/calls',
    icon: History,
    category: 'main',
  },
  {
    name: 'Voicemail',
    href: '/voicemail',
    icon: VoicemailIcon,
    category: 'main',
  },
  {
    name: 'Missed Calls',
    href: '/missed',
    icon: PhoneMissed,
    badge: 3,
    category: 'main',
  },
  {
    name: 'Messages',
    href: '/messages',
    icon: MessageSquare,
    badge: 2,
    category: 'main',
  },
  {
    name: 'Contacts',
    href: '/contacts',
    icon: Users,
    category: 'main',
  },
  {
    name: 'Recordings',
    href: '/recordings',
    icon: Mic,
    category: 'main',
  },

  // VoIP Numbers Category
  {
    name: 'My Numbers',
    href: '/numbers',
    icon: Hash,
    category: 'numbers',
  },

  // Billing Category
  {
    name: 'Credit',
    href: '/billing/credit',
    icon: Zap,
    category: 'billing',
  },
  {
    name: 'Plan & Subscription',
    href: '/settings/billing',
    icon: Sparkles,
    category: 'billing',
  },
  {
    name: 'Number Subscription',
    href: '/billing/numbers',
    icon: Receipt,
    category: 'billing',
  },

  // Preferences & Admin Category
  {
    name: 'Administration',
    href: '/admin',
    icon: ShieldCheck,
    category: 'admin',
  },
  {
    name: 'Team & Users',
    href: '/settings/users',
    icon: Users,
    category: 'admin',
  },
  {
    name: 'IVR Phone Menu',
    href: '/settings/ivr',
    icon: GitFork,
    category: 'admin',
  },
  {
    name: 'Settings',
    href: '/settings',
    icon: Settings,
    category: 'admin',
  },
];

export const MOCK_CURRENT_USER = {
  id: 'user_01',
  email: 'alex.smith@company.internal',
  fullName: 'Alex Smith',
  avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
  role: 'admin' as const,
  status: 'online' as const,
};
