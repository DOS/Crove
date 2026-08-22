export type Language = 'vi' | 'en';

export interface Translations {
  nav: {
    suite: string;
    features: string;
    channels: string;
    channelsBadge: string;
    preview: string;
    howItWorks: string;
    comparison: string;
    pricing: string;
    faq: string;
    login: string;
    getStarted: string;
  };
  hero: {
    announcement: string;
    announcementHighlight: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    startFree: string;
    watchDemo: string;
    trustCardFree: string;
    trustApi: string;
    trustInstant: string;
    mockupUrl: string;
    mockupWorkspaceName: string;
    mockupSynced: string;
    mockupNewPost: string;
    mockupAppPost: string;
    mockupAppFlow: string;
    mockupAppAudience: string;
    mockupAppMedia: string;
    mockupAppAnalytics: string;
    mockupCalendarTab: string;
    mockupPipelineTab: string;
    mockupAnalyticsTab: string;
    mockupPost1Title: string;
    mockupPost1Status: string;
    mockupPost2Title: string;
    mockupPost2Status: string;
    mockupPost3Title: string;
    mockupPost3Status: string;
    mockupAiBadge: string;
    mockupStatMrr: string;
    mockupStatMrrVal: string;
    mockupStatReach: string;
    mockupStatReachVal: string;
  };
  suite: {
    pill: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    app1Title: string;
    app1Tag: string;
    app1Desc: string;
    app2Title: string;
    app2Tag: string;
    app2Desc: string;
    app3Title: string;
    app3Tag: string;
    app3Desc: string;
    app4Title: string;
    app4Tag: string;
    app4Desc: string;
    app5Title: string;
    app5Tag: string;
    app5Desc: string;
  };
  channels: {
    pill: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    tabAll: string;
    tabVideo: string;
    tabSocial: string;
    tabProfessional: string;
    tabCommunity: string;
    tabWeb3: string;
    directBadge: string;
  };
  features: {
    pill: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    card1Badge: string;
    card1Title: string;
    card1Desc: string;
    card1Tag1: string;
    card1Tag2: string;
    card1Tag3: string;
    card2Badge: string;
    card2Title: string;
    card2Desc: string;
    card2BestTime: string;
    card3Badge: string;
    card3Title: string;
    card3Desc: string;
    card4Badge: string;
    card4Title: string;
    card4Desc: string;
    card5Badge: string;
    card5Title: string;
    card5Desc: string;
  };
  preview: {
    pill: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    templatesLabel: string;
    tmpl1Title: string;
    tmpl1Content: string;
    tmpl2Title: string;
    tmpl2Content: string;
    tmpl3Title: string;
    tmpl3Content: string;
    aiPolishBtn: string;
    aiPolishing: string;
    copyBtn: string;
    copiedBtn: string;
    placeholder: string;
    scheduleNow: string;
    directPublishBadge: string;
    previewOf: string;
    characters: string;
  };
  howItWorks: {
    pill: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    step1Num: string;
    step1Title: string;
    step1Desc: string;
    step1Highlight: string;
    step2Num: string;
    step2Title: string;
    step2Desc: string;
    step2Highlight: string;
    step3Num: string;
    step3Title: string;
    step3Desc: string;
    step3Highlight: string;
  };
  comparison: {
    pill: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    featureHeader: string;
    croveCol: string;
    siloCol: string;
    row1Feature: string;
    row1Crove: string;
    row1Silo: string;
    row1Buffer: string;
    row1Hootsuite: string;
    row1Later: string;
    row2Feature: string;
    row2Later: string;
    row3Feature: string;
    row3Crove: string;
    row3Silo: string;
    row3Buffer: string;
    row3Hootsuite: string;
    row3Later: string;
    row4Feature: string;
    row5Feature: string;
    row6Feature: string;
    row7Feature: string;
    row8Feature: string;
    row8Crove: string;
    row8Silo: string;
    row8Buffer: string;
    row8Hootsuite: string;
    row8Later: string;
  };
  pricing: {
    pill: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    monthly: string;
    yearly: string;
    saveBadge: string;
    starterName: string;
    starterDesc: string;
    starterPrice: string;
    starterPeriod: string;
    starterBadge: string;
    starterCta: string;
    proName: string;
    proDesc: string;
    proPriceMonthly: string;
    proPriceYearly: string;
    proPeriodMonthly: string;
    proPeriodYearly: string;
    proBadge: string;
    proCta: string;
    agencyName: string;
    agencyDesc: string;
    agencyPriceMonthly: string;
    agencyPriceYearly: string;
    agencyPeriodMonthly: string;
    agencyPeriodYearly: string;
    agencyBadge: string;
    agencyCta: string;
  };
  testimonials: {
    pill: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    t1Name: string;
    t1Role: string;
    t1Content: string;
    t1Channels: string;
    t2Name: string;
    t2Role: string;
    t2Content: string;
    t2Channels: string;
    t3Name: string;
    t3Role: string;
    t3Content: string;
    t3Channels: string;
  };
  faq: {
    pill: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    q1: string;
    a1: string;
    q2: string;
    a2: string;
    q3: string;
    a3: string;
    q4: string;
    a4: string;
    q5: string;
    a5: string;
    q6: string;
    a6: string;
  };
  cta: {
    pill: string;
    titleStart: string;
    titleGradient: string;
    titleEnd: string;
    subtitle: string;
    startBtn: string;
    viewPricing: string;
    trustCard: string;
    trustTime: string;
  };
  footer: {
    desc: string;
    uptime: string;
    productTitle: string;
    featLink: string;
    channelsLink: string;
    previewLink: string;
    pricingLink: string;
    compareLink: string;
    platformsTitle: string;
    accountTitle: string;
    loginLink: string;
    registerLink: string;
    privacyLink: string;
    termsLink: string;
    rights: string;
    builtWith: string;
  };
}

export const translations: Record<Language, Translations> = {
  vi: {
    nav: {
      suite: 'Ứng dụng OS',
      features: 'Tính năng',
      channels: '28+ Kênh',
      channelsBadge: 'Hot',
      preview: 'Trải nghiệm',
      howItWorks: 'Cách hoạt động',
      comparison: 'So sánh & Tiết kiệm',
      pricing: 'Bảng giá',
      faq: 'FAQ',
      login: 'Đăng nhập',
      getStarted: 'Bắt đầu miễn phí',
    },
    hero: {
      announcement: 'Crove 2.0 • The Modern Business OS',
      announcementHighlight: 'Solo Founders & SMEs',
      titleStart: 'Hệ Điều Hành Kinh Doanh ',
      titleGradient: 'Toàn Diện & Tự Động',
      titleEnd: ' Cho Solo Founder & SME',
      subtitle:
        'Hợp nhất toàn bộ hoạt động kinh doanh vào 1 nền tảng duy nhất: Phân phối đa kênh 28+ nền tảng, AI Content Copilot, Tự động hóa quy trình, Quản lý Khách hàng & Báo cáo tăng trưởng thời gian thực. Tiết kiệm 80% chi phí phần mềm.',
      startFree: 'Bắt đầu miễn phí ngay',
      watchDemo: 'Khám phá Hệ sinh thái OS',
      trustCardFree: 'Không cần thẻ tín dụng',
      trustInstant: '1 Tài khoản DOS ID duy nhất',
      trustApi: 'Tiết kiệm $300+/tháng cho SaaS',
      mockupUrl: 'crove.com/workspace • Solo Founder HQ',
      mockupWorkspaceName: 'Crove Business OS',
      mockupSynced: 'Hệ sinh thái đồng bộ',
      mockupNewPost: 'Tạo nội dung mới',
      mockupAppPost: 'Crove Post (Social OS)',
      mockupAppFlow: 'Crove Flow (Automation)',
      mockupAppAudience: 'Crove Audience (CRM)',
      mockupAppMedia: 'Crove Media (Asset OS)',
      mockupAppAnalytics: 'Crove Analytics (Growth)',
      mockupCalendarTab: 'Lịch Đa Kênh',
      mockupPipelineTab: 'Quy Trình Tự Động',
      mockupAnalyticsTab: 'Báo Cáo Doanh Thu',
      mockupPost1Title: 'Video Launch Sản Phẩm • TikTok + Shorts + Reels',
      mockupPost1Status: 'Đã lên lịch • 19:30 Tối nay',
      mockupPost2Title: 'Case Study Tăng Trưởng MRR • LinkedIn + X Thread',
      mockupPost2Status: 'Tự động phân phối • 09:00 Ngày mai',
      mockupPost3Title: 'Email Newsletter & Khuyến Mãi Đầu Tuần • Audience List',
      mockupPost3Status: 'Đang chuẩn bị • Thứ Hai',
      mockupAiBadge: 'AI Copilot Đang Tối Ưu',
      mockupStatMrr: 'Doanh thu tháng (MRR)',
      mockupStatMrrVal: '$12,450 (+24%)',
      mockupStatReach: 'Lượt tiếp cận đa kênh',
      mockupStatReachVal: '482.5K Lượt xem',
    },
    suite: {
      pill: 'Kiến Trúc Hợp Nhất',
      titleStart: 'Mọi Ứng Dụng Thiết Yếu Trong ',
      titleGradient: '1 Business OS Duy Nhất',
      titleEnd: '',
      subtitle:
        'Thay vì phải trả tiền cho 5-7 dịch vụ rời rạc đắt đỏ, Crove tích hợp các công nghệ Open Source đỉnh cao nhất thành một hệ điều hành kinh doanh liền mạch cho Solo Founder và SME.',
      app1Title: 'Crove Post (Distribution OS)',
      app1Tag: 'Đang hoạt động • 28+ Kênh',
      app1Desc:
        'Lên lịch và phân phối bài viết, video ngắn 9:16 (TikTok, Shorts, Reels), Twitter Threads, Reddit, LinkedIn trực tiếp qua API chính thức.',
      app2Title: 'Crove Flow (Workflow & Agent OS)',
      app2Tag: 'AI Automations',
      app2Desc:
        'Tự động hóa quy trình kinh doanh, kết nối Webhooks, kích hoạt AI Agents phân loại lead và xử lý tác vụ lặp lại 24/7.',
      app3Title: 'Crove Audience (CRM & Newsletter)',
      app3Tag: 'Lead & Email OS',
      app3Desc:
        'Thu thập khách hàng tiềm năng, phân khúc danh bạ và gửi chiến dịch email marketing tự động với chi phí gần như bằng 0.',
      app4Title: 'Crove Media (Asset Management)',
      app4Tag: 'Cloudflare R2 CDN',
      app4Desc:
        'Thư viện quản lý hình ảnh, video 4K và tài nguyên số tập trung tốc độ cao, hỗ trợ chỉnh sửa và đóng watermark tức thì.',
      app5Title: 'Crove Insights (Unified Analytics)',
      app5Tag: 'Real-time ROI',
      app5Desc:
        'Bảng điều khiển đo lường chuyển đổi từ 28+ mạng xã hội và kênh tiếp thị về doanh thu thực tế mà không cần cài đặt phức tạp.',
    },
    channels: {
      pill: '28+ Kênh Phân Phối Trực Tiếp',
      titleStart: 'Phân Phối Nội Dung Tới ',
      titleGradient: 'Mọi Nơi Khách Hàng Của Bạn Xuất Hiện',
      titleEnd: '',
      subtitle:
        'Tận dụng sức mạnh của Crove Post để đăng tải bài viết, hình ảnh, video ngắn tới hơn 28 nền tảng xã hội, diễn đàn và mạng Web3 chỉ với 1 cú click.',
      tabAll: 'Tất cả (28+)',
      tabVideo: 'Video & Visuals',
      tabSocial: 'Mạng Xã Hội',
      tabProfessional: 'B2B & Blog',
      tabCommunity: 'Cộng Đồng & Chat',
      tabWeb3: 'Web3 & Custom API',
      directBadge: 'API Chính Thức',
    },
    features: {
      pill: 'Sức Mạnh Vượt Trội',
      titleStart: 'Thiết Kế Chuyên Biệt Cho ',
      titleGradient: 'Solo Founders & Doanh Nghiệp Tinh Gọn',
      titleEnd: '',
      subtitle:
        'Tối ưu hóa thời gian và nguồn lực với những tính năng tự động hóa mạnh mẽ nhất.',
      card1Badge: 'AI Content Repurposer',
      card1Title: '1 Ý Tưởng Biến Thành 10 Định Dạng Tối Ưu',
      card1Desc:
        'Nhập 1 chủ đề cốt lõi, AI Copilot tự động viết lại thành Video Script TikTok, Bài viết chuyên sâu LinkedIn, Chuỗi Twitter Threads và Bài thảo luận Reddit đúng giọng điệu.',
      card1Tag1: 'TikTok / Shorts',
      card1Tag2: 'LinkedIn B2B',
      card1Tag3: 'X Threads',
      card2Badge: 'Smart Scheduling',
      card2Title: 'Lịch Đăng Đa Kênh Kéo Thả Trực Quan',
      card2Desc:
        'Quản lý toàn bộ lịch trình truyền thông trong tuần/tháng với giao diện kéo thả mượt mà, hỗ trợ tự động chọn Khung Giờ Vàng (AI Best Time).',
      card2BestTime: 'Khung giờ vàng tối ưu tương tác',
      card3Badge: 'Media Studio',
      card3Title: 'Thiết Kế & Xử Lý Video Trực Tuyến',
      card3Desc:
        'Tích hợp công cụ cắt ghép video 9:16, chèn phụ đề, chỉnh sửa ảnh banner và lưu trữ không giới hạn trên Cloudflare R2 CDN.',
      card4Badge: 'Unified Inbox & CRM',
      card4Title: 'Quản Lý Khách Hàng & Phản Hồi Tập Trung',
      card4Desc:
        'Theo dõi tương tác, thu thập danh sách email người quan tâm và đồng bộ trực tiếp vào CRM mà không cần đổi qua lại hàng chục tab trình duyệt.',
      card5Badge: 'Enterprise Security',
      card5Title: '100% Làm Chủ Dữ Liệu & Bảo Mật',
      card5Desc:
        'Đăng nhập an toàn qua DOS ID OAuth 2.1 PKCE, mã hóa AES-256 cho tokens và hỗ trợ triển khai self-hosted nếu bạn muốn lưu trữ riêng tư hoàn toàn.',
    },
    preview: {
      pill: 'Trải Nghiệm Studio Trực Tuyến',
      titleStart: 'Thử Nghiệm Trợ Lý AI ',
      titleGradient: 'Sáng Tạo & Tối Ưu Nội Dung',
      titleEnd: '',
      subtitle:
        'Chọn một chủ đề mẫu bên dưới hoặc tự nhập nội dung để xem AI của Crove tối ưu bài viết theo từng kênh mạng xã hội.',
      templatesLabel: 'Mẫu nội dung gợi ý:',
      tmpl1Title: '🚀 Launch Sản Phẩm Mới',
      tmpl1Content:
        'Hôm nay chúng tôi chính thức ra mắt Crove 2.0 - Business OS toàn diện cho Solo Founders & SMEs! Hợp nhất lên lịch 28+ kênh, tự động hóa quy trình và quản lý khách hàng chỉ trong 1 nền tảng.',
      tmpl2Title: '💡 Chia Sẻ Kinh Nghiệm Growth',
      tmpl2Content:
        '3 bài học xương máu giúp mình tăng trưởng MRR từ $1k lên $10k trong 6 tháng chỉ với 1 người vận hành: Tự động hóa phân phối nội dung, tập trung vào kênh chuyển đổi cao nhất, và chăm sóc lead tức thì.',
      tmpl3Title: '⚡ Thông Báo Khuyến Mãi',
      tmpl3Content:
        'Chương trình Early Bird đặc biệt: Giảm 40% trọn đời cho 100 Founder đầu tiên đăng ký Crove Pro hôm nay! Đầy đủ tính năng 28+ kênh và AI Copilot không giới hạn.',
      aiPolishBtn: 'AI Tối ưu hóa nội dung',
      aiPolishing: 'AI đang phân tích & viết lại...',
      copyBtn: 'Sao chép nội dung',
      copiedBtn: 'Đã sao chép vào Clipboard!',
      placeholder: 'Nhập nội dung bạn muốn phân phối đa kênh tại đây...',
      scheduleNow: 'Lên lịch phân phối ngay',
      directPublishBadge: 'Sẵn sàng đăng tới 28+ kênh',
      previewOf: 'Bản xem trước giao diện:',
      characters: 'ký tự',
    },
    howItWorks: {
      pill: 'Quy Trình 3 Bước Tinh Gọn',
      titleStart: 'Vận Hành Doanh Nghiệp Tự Động ',
      titleGradient: 'Chỉ Trong 3 Bước',
      titleEnd: '',
      subtitle:
        'Khởi động và biến Crove thành cỗ máy tăng trưởng của bạn trong chưa đầy 5 phút.',
      step1Num: '01',
      step1Title: 'Kết Nối Tài Khoản & Kênh Bán Hàng',
      step1Desc:
        'Đăng nhập bằng DOS ID và kết nối nhanh chóng tới các trang Fanpage, kênh TikTok, YouTube, LinkedIn, X, Discord qua OAuth chính thức.',
      step1Highlight: 'Bảo mật tuyệt đối qua Cloudflare Bridge',
      step2Num: '02',
      step2Title: 'Sáng Tạo & Tự Động Hóa Với AI Copilot',
      step2Desc:
        'Soạn thảo 1 lần, AI Copilot tự động tạo phiên bản chuẩn hóa cho từng nền tảng, lên lịch vào khung giờ vàng và kích hoạt quy trình tự động.',
      step2Highlight: 'Tiết kiệm 15+ giờ làm việc mỗi tuần',
      step3Num: '03',
      step3Title: 'Theo Dõi Tăng Trưởng & Scale Doanh Nghiệp',
      step3Desc:
        'Xem báo cáo tương tác hợp nhất, thu thập lead tự động vào hệ thống CRM và tập trung phát triển sản phẩm của bạn.',
      step3Highlight: 'Doanh thu tăng trưởng bền vững',
    },
    comparison: {
      pill: 'So Sánh Chi Phí & Tính Năng',
      titleStart: 'Tại Sao Solo Founders Chọn ',
      titleGradient: 'Crove Business OS?',
      titleEnd: '',
      subtitle:
        'Một phép tính đơn giản chứng minh sự vượt trội về cả tính năng lẫn chi phí khi gom mọi công cụ rời rạc vào 1 OS duy nhất.',
      featureHeader: 'Tính năng & Năng lực',
      croveCol: 'Crove Business OS',
      siloCol: '5 Công cụ rời rạc (Buffer + Zapier + Mailchimp +...)',
      row1Feature: 'Số kênh mạng xã hội hỗ trợ',
      row1Crove: '28+ Kênh (Bao gồm TikTok, X, Web3, Chat)',
      row1Silo: 'Giới hạn 3 - 8 kênh phổ biến',
      row1Buffer: '8 Kênh',
      row1Hootsuite: '10 Kênh',
      row1Later: '6 Kênh',
      row2Feature: 'Đăng trực tiếp Video ngắn TikTok, Shorts & Reels',
      row2Later: 'Chỉ thông báo đẩy nhắc nhở',
      row3Feature: 'Tích hợp AI Content Copilot & Repurposer',
      row3Crove: 'Không giới hạn (GPT-4o / Claude 3.5)',
      row3Silo: 'Tính phí thêm $15 - $30/tháng',
      row3Buffer: 'Phụ phí thêm',
      row3Hootsuite: 'Gói Enterprise đắt đỏ',
      row3Later: 'Cơ bản',
      row4Feature: 'Tự động tạo Twitter Threads & Reddit Flair',
      row5Feature: 'Hệ thống tự động hóa Workflow & Webhooks',
      row6Feature: 'Quản lý Lead, CRM & Email Marketing',
      row7Feature: 'Đăng nhập 1 chạm qua DOS ID SSO',
      row8Feature: 'Tổng chi phí ước tính mỗi tháng',
      row8Crove: 'Chỉ từ $0 - $19 / tháng',
      row8Silo: '$180 - $350+ / tháng',
      row8Buffer: '$120+ / tháng',
      row8Hootsuite: '$249+ / tháng',
      row8Later: '$80+ / tháng',
    },
    pricing: {
      pill: 'Bảng Giá Minh Bạch',
      titleStart: 'Chi Phí Tinh Gọn ',
      titleGradient: 'Phù Hợp Mọi Giai Đoạn',
      titleEnd: ' Phát Triển',
      subtitle:
        'Bắt đầu miễn phí hôm nay và nâng cấp khi doanh nghiệp của bạn mở rộng quy mô. Không ràng buộc, hủy bất kỳ lúc nào.',
      monthly: 'Thanh toán theo tháng',
      yearly: 'Thanh toán theo năm',
      saveBadge: 'Tiết kiệm 20%',
      starterName: 'Solo Starter',
      starterDesc: 'Dành cho cá nhân & Solo Founder bắt đầu xây dựng thương hiệu cá nhân.',
      starterPrice: '$0',
      starterPeriod: '/ vĩnh viễn',
      starterBadge: 'Miễn phí trải nghiệm',
      starterCta: 'Bắt đầu miễn phí',
      proName: 'Founder Pro',
      proDesc: 'Dành cho nhà sáng lập & SME cần tự động hóa toàn diện và phân phối tối đa.',
      proPriceMonthly: '$19',
      proPriceYearly: '$15',
      proPeriodMonthly: '/ tháng',
      proPeriodYearly: '/ tháng (trả hàng năm)',
      proBadge: 'Được lựa chọn nhiều nhất',
      proCta: 'Trải nghiệm gói Pro',
      agencyName: 'Business Scale',
      agencyDesc: 'Dành cho đội ngũ phát triển, Agency và doanh nghiệp SME nhiều chi nhánh.',
      agencyPriceMonthly: '$49',
      agencyPriceYearly: '$39',
      agencyPeriodMonthly: '/ tháng',
      agencyPeriodYearly: '/ tháng (trả hàng năm)',
      agencyBadge: 'Quyền năng tối đa',
      agencyCta: 'Liên hệ nâng cấp',
    },
    testimonials: {
      pill: 'Cộng Đồng Tin Dùng',
      titleStart: 'Được Yêu Thích Bởi Hàng Ngàn ',
      titleGradient: 'Solo Founders & Growth Marketers',
      titleEnd: '',
      subtitle:
        'Xem các nhà sáng lập nói gì về việc Crove đã giúp họ tiết kiệm hàng trăm giờ và hàng nghìn USD chi phí phần mềm mỗi tháng.',
      t1Name: 'Hoàng Nam',
      t1Role: 'Solo Founder @ SaaSify',
      t1Content:
        'Trước đây mình phải trả gần $200/tháng cho Buffer và Zapier để duy trì phân phối bài viết. Với Crove, mọi thứ từ video TikTok đến bài viết LinkedIn và email newsletter đều chạy tự động chỉ trong 1 dashboard duy nhất!',
      t1Channels: 'TikTok, X & LinkedIn',
      t2Name: 'Trang Lê',
      t2Role: 'Content Creator & Growth Lead',
      t2Content:
        'Tính năng AI Repurposer của Crove thực sự đỉnh cao. Mình chỉ cần viết 1 bài blog cốt lõi là hệ thống tự chia nhỏ thành Twitter Thread và kịch bản video Shorts trong 5 giây.',
      t2Channels: 'Shorts & X Threads',
      t3Name: 'Hải Long',
      t3Role: 'CEO @ TechViet Agency',
      t3Content:
        'Giao diện cực kỳ mượt mà, dark mode chuẩn gu lập trình viên và đăng nhập qua DOS ID rất tiện. Đội ngũ mình quản lý 15 Fanpage và kênh TikTok cho khách hàng vô cùng nhẹ nhàng.',
      t3Channels: '28+ Kênh đa nền tảng',
    },
    faq: {
      pill: 'Câu Hỏi Thường Gặp',
      titleStart: 'Giải Đáp Thắc Mắc Về ',
      titleGradient: 'Crove Business OS',
      titleEnd: '',
      subtitle: 'Mọi điều bạn cần biết trước khi bắt đầu sử dụng Crove.',
      q1: 'Crove Business OS khác gì so với các công cụ lên lịch đăng bài truyền thống như Buffer hay Hootsuite?',
      a1: 'Buffer hay Hootsuite chỉ đơn thuần là công cụ lên lịch bài đăng với chi phí đắt đỏ ($100-$300+/tháng) và số lượng kênh giới hạn. Crove là một Business OS toàn diện tích hợp: phân phối 28+ kênh (bao gồm cả TikTok, Reels, Reddit, Web3), AI Content Repurposer, quy trình tự động hóa workflow, quản lý CRM và phân tích tăng trưởng hợp nhất với chi phí tiết kiệm tới 80%.',
      q2: 'Tôi có bị khóa tài khoản khi đăng bài tự động qua Crove không?',
      a2: 'Hoàn toàn không. Crove sử dụng 100% API chính thức (Official Partner APIs) từ TikTok, Meta (Facebook/Instagram), Google (YouTube), LinkedIn, X (Twitter), Reddit... đảm bảo tuân thủ nghiêm ngặt chính sách bảo mật của các nền tảng.',
      q3: 'DOS ID là gì và tại sao Crove lại sử dụng nó?',
      a3: 'DOS ID là hệ thống Single Sign-On (SSO) an toàn chuẩn OAuth 2.1 PKCE được triển khai trên nền tảng Cloudflare Edge. Nhờ DOS ID, bạn chỉ cần 1 tài khoản duy nhất để truy cập toàn bộ hệ sinh thái ứng dụng của Crove và đối tác mà không phải nhớ nhiều mật khẩu.',
      q4: 'Tôi có thể dùng thử miễn phí không?',
      a4: 'Có. Gói Solo Starter hoàn toàn miễn phí trọn đời, cho phép bạn kết nối các kênh cơ bản và trải nghiệm đầy đủ tính năng cốt lõi trước khi quyết định nâng cấp.',
      q5: 'Crove có hỗ trợ đăng video ngắn tự động (Shorts, Reels, TikTok) không?',
      a5: 'Có. Crove hỗ trợ tải lên và lên lịch video dọc chuẩn 9:16 trực tiếp tới TikTok, YouTube Shorts và Instagram/Facebook Reels kèm hashtag, âm thanh và thumbnail tùy chỉnh.',
      q6: 'Tôi có thể hủy gói đăng ký bất cứ lúc nào không?',
      a6: 'Chắc chắn rồi. Bạn có thể tự do hủy gói hoặc chuyển đổi giữa gói tháng và gói năm bất kỳ lúc nào trực tiếp trong trang Cài đặt tài khoản mà không có bất kỳ phí phạt nào.',
    },
    cta: {
      pill: 'Sẵn Sàng Bứt Phá Doanh Thu?',
      titleStart: 'Biến Crove Thành Trợ Lý ',
      titleGradient: 'Vận Hành Doanh Nghiệp Của Bạn',
      titleEnd: ' Ngay Hôm Nay',
      subtitle:
        'Tham gia cùng hàng ngàn Solo Founders và SME đang tự động hóa quy trình phân phối nội dung và mở rộng quy mô kinh doanh.',
      startBtn: 'Bắt đầu miễn phí với DOS ID',
      viewPricing: 'Xem bảng giá chi tiết',
      trustCard: 'Không cần thẻ tín dụng',
      trustTime: 'Thiết lập trong 2 phút',
    },
    footer: {
      desc: 'Hệ điều hành kinh doanh toàn diện (Business OS) dành cho Solo Founders & SMEs. Hợp nhất phân phối đa kênh 28+ nền tảng, tự động hóa quy trình và quản lý tăng trưởng.',
      uptime: 'Hệ thống hoạt động 99.98%',
      productTitle: 'Hệ Sinh Thái OS',
      featLink: 'Crove Post (Social OS)',
      channelsLink: '28+ Kênh Phân Phối',
      previewLink: 'AI Content Studio',
      pricingLink: 'Bảng Giá & Gói Cước',
      compareLink: 'So Sánh & Tiết Kiệm',
      platformsTitle: 'Kênh Phổ Biến',
      accountTitle: 'Tài Khoản & Pháp Lý',
      loginLink: 'Đăng Nhập DOS ID',
      registerLink: 'Đăng Ký Tài Khoản',
      privacyLink: 'Chính Sách Bảo Mật',
      termsLink: 'Điều Khoản Dịch Vụ',
      rights: 'Bản quyền thuộc về Crove. Tất cả các quyền được bảo lưu.',
      builtWith: 'Xây dựng với chuẩn mã nguồn mở tốt nhất.',
    },
  },
  en: {
    nav: {
      suite: 'OS Suite',
      features: 'Features',
      channels: '28+ Channels',
      channelsBadge: 'Hot',
      preview: 'Studio Preview',
      howItWorks: 'How It Works',
      comparison: 'Compare & Save',
      pricing: 'Pricing',
      faq: 'FAQ',
      login: 'Sign In',
      getStarted: 'Start Free',
    },
    hero: {
      announcement: 'Crove 2.0 • The Modern Business OS',
      announcementHighlight: 'Solo Founders & SMEs',
      titleStart: 'The All-in-One ',
      titleGradient: 'Business OS & AI Copilot',
      titleEnd: ' for Solo Founders & SMEs',
      subtitle:
        'Consolidate your entire business growth stack in one unified platform: 28+ channel social distribution, AI Content Copilot, workflow automations, customer CRM, and real-time revenue analytics. Save 80% on software costs.',
      startFree: 'Start Free Today',
      watchDemo: 'Explore OS Suite',
      trustCardFree: 'No credit card required',
      trustInstant: 'Single DOS ID login',
      trustApi: 'Save $300+/mo on SaaS subscriptions',
      mockupUrl: 'crove.com/workspace • Solo Founder HQ',
      mockupWorkspaceName: 'Crove Business OS',
      mockupSynced: 'OS Ecosystem Synced',
      mockupNewPost: 'New Content Piece',
      mockupAppPost: 'Crove Post (Social OS)',
      mockupAppFlow: 'Crove Flow (Automation)',
      mockupAppAudience: 'Crove Audience (CRM)',
      mockupAppMedia: 'Crove Media (Asset OS)',
      mockupAppAnalytics: 'Crove Analytics (Growth)',
      mockupCalendarTab: 'Multi-Channel Calendar',
      mockupPipelineTab: 'Automated Pipelines',
      mockupAnalyticsTab: 'Revenue Dashboard',
      mockupPost1Title: 'Product Launch Video • TikTok + Shorts + Reels',
      mockupPost1Status: 'Scheduled • 7:30 PM Tonight',
      mockupPost2Title: 'MRR Growth Case Study • LinkedIn + X Thread',
      mockupPost2Status: 'Auto-publishing • 9:00 AM Tomorrow',
      mockupPost3Title: 'Weekly Newsletter & Offer • Audience List',
      mockupPost3Status: 'Drafting • Monday',
      mockupAiBadge: 'AI Copilot Optimizing',
      mockupStatMrr: 'Monthly Revenue (MRR)',
      mockupStatMrrVal: '$12,450 (+24%)',
      mockupStatReach: 'Cross-Channel Reach',
      mockupStatReachVal: '482.5K Views',
    },
    suite: {
      pill: 'Unified Architecture',
      titleStart: 'Every Essential Tool Inside ',
      titleGradient: 'One Unified Business OS',
      titleEnd: '',
      subtitle:
        'Instead of paying hundreds of dollars for fragmented tools, Crove integrates best-in-class open-source engines into one seamless operating system for founders and lean teams.',
      app1Title: 'Crove Post (Distribution OS)',
      app1Tag: 'Live • 28+ Channels',
      app1Desc:
        'Schedule and broadcast long-form posts, 9:16 short videos (TikTok, Shorts, Reels), Twitter Threads, and Reddit via official APIs.',
      app2Title: 'Crove Flow (Workflow & Agent OS)',
      app2Tag: 'AI Automations',
      app2Desc:
        'Automate business workflows, connect custom Webhooks, and deploy 24/7 AI agents to qualify leads and eliminate repetitive tasks.',
      app3Title: 'Crove Audience (CRM & Newsletter)',
      app3Tag: 'Lead & Email OS',
      app3Desc:
        'Capture leads, segment your audience, and dispatch automated newsletter campaigns with virtually zero overhead.',
      app4Title: 'Crove Media (Asset Management)',
      app4Tag: 'Cloudflare R2 CDN',
      app4Desc:
        'Ultra-fast digital asset manager for images, 4K videos, and documents with instant watermarking and CDN optimization.',
      app5Title: 'Crove Insights (Unified Analytics)',
      app5Tag: 'Real-time ROI',
      app5Desc:
        'Measure real business ROI by attributing traffic, engagement, and conversions across all 28+ channels back to revenue.',
    },
    channels: {
      pill: '28+ Direct Publishing Channels',
      titleStart: 'Broadcast Content Everywhere ',
      titleGradient: 'Your Customers Hang Out',
      titleEnd: '',
      subtitle:
        'Harness the power of Crove Post to distribute vertical videos, carousel graphics, articles, and discussions across 28+ top platforms simultaneously.',
      tabAll: 'All Channels (28+)',
      tabVideo: 'Video & Visuals',
      tabSocial: 'Social Networks',
      tabProfessional: 'B2B & Blogs',
      tabCommunity: 'Community & Chat',
      tabWeb3: 'Web3 & Custom API',
      directBadge: 'Official API',
    },
    features: {
      pill: 'Built For Speed',
      titleStart: 'Engineered For ',
      titleGradient: 'Solo Founders & Lean Teams',
      titleEnd: '',
      subtitle:
        'Supercharge your output with high-performance tools that automate manual growth operations.',
      card1Badge: 'AI Content Repurposer',
      card1Title: 'Turn 1 Idea Into 10 Channel-Specific Assets',
      card1Desc:
        'Drop in a core thought, and AI Copilot instantly generates a TikTok script, LinkedIn authority post, Twitter thread, and Reddit conversation starter tailored to platform algorithms.',
      card1Tag1: 'TikTok / Shorts',
      card1Tag2: 'LinkedIn B2B',
      card1Tag3: 'X Threads',
      card2Badge: 'Smart Scheduling',
      card2Title: 'Visual Drag & Drop Multi-Channel Calendar',
      card2Desc:
        'Orchestrate your weekly and monthly campaigns with fluid calendar management and AI Best Time prediction for maximum engagement.',
      card2BestTime: 'Peak engagement window detected',
      card3Badge: 'Media Studio',
      card3Title: 'In-Browser 9:16 Video & Graphics Editor',
      card3Desc:
        'Trim vertical reels, generate auto-subtitles, polish banners, and store high-resolution assets on unlimited Cloudflare R2 CDN storage.',
      card4Badge: 'Unified Inbox & CRM',
      card4Title: 'Centralized Audience & Lead Pipeline',
      card4Desc:
        'Track engagement, capture prospective customer emails, and sync contacts seamlessly without juggling dozens of open tabs.',
      card5Badge: 'Enterprise Security',
      card5Title: '100% Data Sovereignty & Encryption',
      card5Desc:
        'Secured with DOS ID OAuth 2.1 PKCE, AES-256 token encryption, and full self-hosted compatibility for total privacy control.',
    },
    preview: {
      pill: 'Interactive Studio Demo',
      titleStart: 'Experience The AI Content ',
      titleGradient: 'Creation & Repurposing Engine',
      titleEnd: '',
      subtitle:
        'Select a template below or enter your own draft to see how Crove formats and optimizes your message across platforms.',
      templatesLabel: 'Preset Templates:',
      tmpl1Title: '🚀 Product Launch Announcement',
      tmpl1Content:
        'Today we are officially launching Crove 2.0 - The All-in-One Business OS for Solo Founders & SMEs! 28+ channel scheduling, AI workflow automation, and unified analytics in one seamless workspace.',
      tmpl2Title: '💡 Growth Lessons & Takeaways',
      tmpl2Content:
        '3 hard-won lessons that scaled our MRR from $1k to $10k in 6 months as a solo founder: Automate multi-channel distribution, focus obsessively on high-intent channels, and engage inbound leads within 60 seconds.',
      tmpl3Title: '⚡ Limited Time Promotion',
      tmpl3Content:
        'Exclusive Early Bird Deal: Get 40% off Crove Pro lifetime access for the first 100 founders who sign up today! Includes 28+ channels and unlimited AI Copilot.',
      aiPolishBtn: 'AI Polish & Optimize',
      aiPolishing: 'AI analyzing and formatting...',
      copyBtn: 'Copy to Clipboard',
      copiedBtn: 'Copied to Clipboard!',
      placeholder: 'Type your message or launch announcement here...',
      scheduleNow: 'Schedule Cross-Post Now',
      directPublishBadge: 'Ready for 28+ channels',
      previewOf: 'Platform Preview:',
      characters: 'characters',
    },
    howItWorks: {
      pill: '3-Step Setup',
      titleStart: 'Automate Your Business Operations in ',
      titleGradient: 'Just 3 Steps',
      titleEnd: '',
      subtitle:
        'Get Crove up and running as your autonomous growth engine in under 5 minutes.',
      step1Num: '01',
      step1Title: 'Connect Accounts with 1-Click DOS ID',
      step1Desc:
        'Sign in securely via DOS ID and authorize TikTok, YouTube, Meta, LinkedIn, X, Discord, and Telegram using official OAuth 2.1 protocols.',
      step1Highlight: 'Cloudflare Edge security & encryption',
      step2Num: '02',
      step2Title: 'Create & Automate with AI Copilot',
      step2Desc:
        'Draft once, let AI format channel-native posts, automatically queue them for peak engagement hours, and trigger automated follow-ups.',
      step2Highlight: 'Save 15+ manual hours every single week',
      step3Num: '03',
      step3Title: 'Monitor Growth & Scale Revenue',
      step3Desc:
        'Inspect cross-channel performance on unified dashboards, collect leads into your audience CRM, and focus on building your product.',
      step3Highlight: 'Predictable, compounded revenue growth',
    },
    comparison: {
      pill: 'Cost & Capability Breakdown',
      titleStart: 'Why Solo Founders Choose ',
      titleGradient: 'Crove Business OS',
      titleEnd: ' Over Bloated Tool Stacks',
      subtitle:
        'See how consolidating fragmented subscriptions into one integrated operating system gives you more power for a fraction of the cost.',
      featureHeader: 'Features & Capabilities',
      croveCol: 'Crove Business OS',
      siloCol: '5 Fragmented Subscriptions (Buffer + Zapier + Mailchimp +...)',
      row1Feature: 'Supported Social Channels',
      row1Crove: '28+ Channels (TikTok, Shorts, X, Web3, Chat)',
      row1Silo: 'Limited to 3 - 8 basic platforms',
      row1Buffer: '8 Channels',
      row1Hootsuite: '10 Channels',
      row1Later: '6 Channels',
      row2Feature: 'Direct 9:16 Video Publishing (TikTok, Shorts, Reels)',
      row2Later: 'Push notifications only',
      row3Feature: 'Integrated AI Content Copilot & Repurposer',
      row3Crove: 'Unlimited (GPT-4o / Claude 3.5)',
      row3Silo: 'Extra $15 - $30/mo add-on',
      row3Buffer: 'Paid add-on',
      row3Hootsuite: 'Enterprise only',
      row3Later: 'Basic',
      row4Feature: 'Automated Twitter Threads & Reddit Flairs',
      row5Feature: 'Workflow Automations & Custom Webhooks',
      row6Feature: 'Audience CRM & Email Campaign Dispatch',
      row7Feature: 'Single Sign-On (DOS ID OAuth 2.1)',
      row8Feature: 'Estimated Total Monthly Software Cost',
      row8Crove: 'Starts Free ($0 - $19 / mo)',
      row8Silo: '$180 - $350+ / mo',
      row8Buffer: '$120+ / mo',
      row8Hootsuite: '$249+ / mo',
      row8Later: '$80+ / mo',
    },
    pricing: {
      pill: 'Simple & Transparent',
      titleStart: 'Predictable Pricing for ',
      titleGradient: 'Every Stage of Growth',
      titleEnd: '',
      subtitle:
        'Start for free and upgrade as your audience and revenue scale. Cancel anytime with zero lock-in.',
      monthly: 'Billed monthly',
      yearly: 'Billed yearly',
      saveBadge: 'Save 20%',
      starterName: 'Solo Starter',
      starterDesc: 'Perfect for individual founders and creators building their personal brand.',
      starterPrice: '$0',
      starterPeriod: '/ forever',
      starterBadge: 'Free Tier',
      starterCta: 'Start For Free',
      proName: 'Founder Pro',
      proDesc: 'For fast-growing founders and SMEs needing full automation and maximum reach.',
      proPriceMonthly: '$19',
      proPriceYearly: '$15',
      proPeriodMonthly: '/ mo',
      proPeriodYearly: '/ mo (billed annually)',
      proBadge: 'Most Popular',
      proCta: 'Upgrade to Pro',
      agencyName: 'Business Scale',
      agencyDesc: 'For multi-brand agencies and businesses requiring team collaboration.',
      agencyPriceMonthly: '$49',
      agencyPriceYearly: '$39',
      agencyPeriodMonthly: '/ mo',
      agencyPeriodYearly: '/ mo (billed annually)',
      agencyBadge: 'Maximum Power',
      agencyCta: 'Scale Your Business',
    },
    testimonials: {
      pill: 'Loved by Builders',
      titleStart: 'Trusted by Thousands of ',
      titleGradient: 'Solo Founders & Growth Marketers',
      titleEnd: '',
      subtitle:
        'Hear from entrepreneurs who streamlined their operations and cut hundreds of dollars in SaaS fees with Crove.',
      t1Name: 'Alex Nam',
      t1Role: 'Solo Founder @ SaaSify',
      t1Content:
        'I used to pay nearly $200/mo across Buffer and Zapier just to keep our content engine alive. Crove combined everything into one beautiful dashboard with AI that actually understands social algorithms.',
      t1Channels: 'TikTok, X & LinkedIn',
      t2Name: 'Elena Tran',
      t2Role: 'Content Creator & Growth Lead',
      t2Content:
        'The AI Repurposer is unbelievable. I write one core article and Crove turns it into a Twitter thread and short video script in 5 seconds. My reach tripled in month one.',
      t2Channels: 'Shorts & X Threads',
      t3Name: 'Marcus Long',
      t3Role: 'CEO @ TechViet Agency',
      t3Content:
        'The dark mode UI feels like Linear, and DOS ID SSO makes onboarding effortless. Managing 15 client accounts across TikTok and Facebook has never been this smooth.',
      t3Channels: '28+ Channels Supported',
    },
    faq: {
      pill: 'Got Questions?',
      titleStart: 'Frequently Asked Questions About ',
      titleGradient: 'Crove Business OS',
      titleEnd: '',
      subtitle: 'Everything you need to know about getting started with Crove.',
      q1: 'How is Crove Business OS different from traditional social media schedulers like Buffer or Hootsuite?',
      a1: 'Buffer and Hootsuite are single-purpose tools with high price tags ($100-$300+/mo) and limited channel integrations. Crove is an all-in-one Business OS combining 28+ channel distribution (including TikTok, Reels, Reddit, Web3), AI Content Copilot, workflow automations, customer CRM, and growth analytics at an 80% lower cost.',
      q2: 'Are automated posts safe from account shadowbans?',
      a2: 'Yes, 100%. Crove interacts strictly with official Partner APIs from TikTok, Meta, Google, LinkedIn, X, and Reddit, complying with all platform rate limits and security guidelines.',
      q3: 'What is DOS ID and why does Crove use it?',
      a3: 'DOS ID is our enterprise-grade Single Sign-On (SSO) built on Cloudflare Edge with OAuth 2.1 PKCE. It provides instant, secure access across the entire Crove ecosystem without requiring separate passwords.',
      q4: 'Can I use Crove for free?',
      a4: 'Yes! The Solo Starter plan is 100% free forever, providing full access to core scheduling and essential AI features so you can test the value before upgrading.',
      q5: 'Does Crove support automated vertical video uploads (Shorts, Reels, TikTok)?',
      a5: 'Yes. Crove directly uploads and schedules native 9:16 vertical videos to TikTok, YouTube Shorts, and Instagram/Facebook Reels with custom captions, hashtags, and sound tags.',
      q6: 'Can I cancel my subscription at any time?',
      a6: 'Absolutely. You can cancel or change your plan at any time with one click from your account billing settings without any cancellation fees.',
    },
    cta: {
      pill: 'Ready to Scale?',
      titleStart: 'Make Crove Your Autonomous ',
      titleGradient: 'Business Growth Engine',
      titleEnd: ' Today',
      subtitle:
        'Join thousands of solo founders and modern SMEs automating their distribution, marketing, and customer operations.',
      startBtn: 'Get Started Free with DOS ID',
      viewPricing: 'View Pricing & Plans',
      trustCard: 'No credit card required',
      trustTime: 'Set up in 2 minutes',
    },
    footer: {
      desc: 'The modern all-in-one Business OS for Solo Founders & SMEs. Consolidating 28+ channel social distribution, AI workflows, and customer analytics in one unified workspace.',
      uptime: '99.98% System Uptime',
      productTitle: 'OS Ecosystem',
      featLink: 'Crove Post (Social OS)',
      channelsLink: '28+ Channel Distribution',
      previewLink: 'AI Content Studio',
      pricingLink: 'Plans & Pricing',
      compareLink: 'Compare & Save',
      platformsTitle: 'Popular Channels',
      accountTitle: 'Account & Legal',
      loginLink: 'Sign in with DOS ID',
      registerLink: 'Create Account',
      privacyLink: 'Privacy Policy',
      termsLink: 'Terms of Service',
      rights: 'Copyright Crove. All rights reserved.',
      builtWith: 'Engineered with high-performance open standards.',
    },
  },
};
