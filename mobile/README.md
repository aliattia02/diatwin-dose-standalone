# NATIVE Mobile App

React Native mobile application for the NATIVE diabetes management platform, built with Expo and Expo Router.

## Features

- **Authentication**: Login, registration, password reset
- **Dashboard**: Overview of glucose readings, recent meals, and quick actions
- **Meal Logging**: Log meals with food items, portions, and get insulin recommendations
- **Glucose Tracking**: Record blood sugar readings with status indicators
- **Insulin Logging**: Log insulin doses with support for multiple insulin types
- **History View**: View all logged entries with filtering
- **Profile & Settings**: View/edit patient constants, medications, and export data

## Tech Stack

- **Framework**: React Native with Expo
- **Navigation**: Expo Router (file-based routing)
- **State Management**: Zustand
- **API Client**: Axios
- **Storage**: AsyncStorage & Expo SecureStore
- **Shared Library**: @native/shared (types, constants, utilities)

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Expo Go app (for testing on device)

### Installation

1. Install dependencies:
   ```bash
   cd mobile
   npm install
   ```

2. Build the shared library:
   ```bash
   cd ../shared
   npm install
   npm run build
   cd ../mobile
   ```

3. Start the development server:
   ```bash
   npm start
   ```

4. Scan the QR code with Expo Go (Android) or Camera app (iOS)

### Environment Configuration

Copy `.env.example` to `.env` and configure:
```
API_URL=http://your-backend-url:5000
API_VERSION=v1
```

## Project Structure

```
mobile/
├── app/                    # Expo Router pages
│   ├── (auth)/            # Authentication screens
│   ├── (app)/             # Main app screens
│   │   ├── (tabs)/        # Tab navigator
│   │   ├── log/           # Logging screens
│   │   ├── meal/          # Meal detail
│   │   └── settings/      # Settings screens
│   ├── _layout.tsx        # Root layout
│   └── index.tsx          # Entry point
├── components/            # Reusable components
│   ├── ui/               # Basic UI components
│   ├── forms/            # Form components
│   └── dashboard/        # Dashboard widgets
├── services/api/         # API services
├── store/                # Zustand stores
├── hooks/                # Custom hooks
├── constants/            # Theme and constants
├── types/                # TypeScript types
├── utils/                # Utility functions
└── config/               # Configuration
```

## API Integration

The app connects to the NATIVE backend API. Endpoints are defined in `services/api/endpoints.ts`. The API client handles:
- Authentication tokens
- Request/response interceptors
- Error handling
- Offline queue management

## Offline Support

The app supports offline-first operation:
- Data is cached locally
- Actions are queued when offline
- Automatic sync when back online

## Theme

The app uses a consistent design system matching the web app:
- Primary color: #8031A7 (Purple)
- Typography scale from h1 to small
- Consistent spacing and border radius
- Glucose status colors (low, normal, high)

## Building for Production

```bash
# Build for Android
npx expo build:android

# Build for iOS
npx expo build:ios
```

## Contributing

1. Follow TypeScript best practices
2. Use the shared library for types and utilities
3. Keep components small and focused
4. Add loading and error states to all API calls

## License

UNLICENSED - Private repository
