/**
 * Deployment Configuration for Different Cloud Providers
 */

export type DeploymentProvider = "vercel" | "aws-amplify" | "gcp" | "azure" | "netlify";

export const deploymentConfigs: Record<DeploymentProvider, any> = {
  vercel: {
    buildCommand: "npm run build",
    outputDirectory: "dist",
    env: {
      VITE_MODEL_URL: "@model_cdn_url",
      VITE_EXECUTION_PROVIDERS: "webgpu,wasm",
    },
    config: {
      functions: {
        "api/**": {
          memory: 1024,
          maxDuration: 60,
        },
      },
    },
  },

  "aws-amplify": {
    buildCommand: "npm run build",
    baseDirectory: "./",
    framework: "react",
    env: {
      VITE_MODEL_URL: "s3://your-bucket/models/dr-classification.onnx",
      VITE_EXECUTION_PROVIDERS: "webgpu,wasm",
    },
    deploy: {
      s3ModelPath: "s3://your-bucket/models/",
      cloudFrontDistribution: "D1234EXAMPLE",
    },
  },

  "gcp": {
    buildCommand: "npm run build",
    runtime: "nodejs20",
    env: {
      VITE_MODEL_URL: "gs://your-bucket/models/dr-classification.onnx", 
      VITE_EXECUTION_PROVIDERS: "webgpu,wasm",
    },
    deploy: {
      region: "us-central1",
      memory: "512MB",
      timeout: "60s",
    },
  },

  azure: {
    buildCommand: "npm run build",
    appLocation: "/",
    outputLocation: "dist",
    env: {
      VITE_MODEL_URL: "https://youraccount.blob.core.windows.net/models/dr-classification.onnx",
      VITE_EXECUTION_PROVIDERS: "webgpu,wasm",
    },
    deploy: {
      resourceGroup: "dr-detection-rg",
      location: "eastus",
    },
  },

  netlify: {
    buildCommand: "npm run build",
    publish: "dist",
    env: {
      VITE_MODEL_URL: "@model_url",
      VITE_EXECUTION_PROVIDERS: "webgpu,wasm",
    },
    functions: "functions",
  },
};

/**
 * Quick deployment commands by provider
 */
export const deploymentCommands: Record<DeploymentProvider, string[]> = {
  vercel: [
    "npm install -g vercel",
    "vercel login",
    "vercel env add VITE_MODEL_URL https://cdn.example.com/models/dr-classification.onnx",
    "vercel deploy --prod",
  ],

  "aws-amplify": [
    "npm install -g @aws-amplify/cli",
    "amplify init",
    "amplify add hosting",
    "aws s3 cp public/models/dr-classification.onnx s3://your-bucket/models/",
    "amplify publish",
  ],

  gcp: [
    "gcloud init",
    "gcloud run deploy dr-detection --source . --region us-central1 --allow-unauthenticated",
    "gsutil cp public/models/dr-classification.onnx gs://your-bucket/models/",
  ],

  azure: [
    "az login",
    "az group create --name dr-detection-rg --location eastus",
    "az staticwebapp create --name dr-detection --resource-group dr-detection-rg --source . --build-folder dist",
    "az storage blob upload --account-name youraccount --container-name models --name dr-classification.onnx --file public/models/dr-classification.onnx",
  ],

  netlify: [
    "npm install -g netlify-cli",
    "netlify login",
    "netlify link",
    "netlify env:set VITE_MODEL_URL https://cdn.example.com/models/dr-classification.onnx",
    "netlify deploy --prod",
  ],
};

/**
 * Model optimization recommendations by provider
 */
export const optimizationTips: Record<DeploymentProvider, string[]> = {
  vercel: [
    "✓ Use Vercel Blob for model storage",
    "✓ Enable Vercel Analytics to track inference time",
    "✓ Set Content-Delivery-Network (CDN) TTL to 365 days",
    "✓ Enable Gzip/Brotli compression in vercel.json",
  ],

  "aws-amplify": [
    "✓ Upload model to S3 with CloudFront distribution",
    "✓ Set S3 bucket versioning for model rollbacks",
    "✓ Enable server-side encryption",
    "✓ Use S3 Transfer Acceleration for faster uploads",
  ],

  gcp: [
    "✓ Use Cloud Storage with Nearline class for cost savings",
    "✓ Enable Cloud CDN for model distribution",
    "✓ Use Load Balancer with autoscaling",
    "✓ Monitor with Cloud Logging and Cloud Trace",
  ],

  azure: [
    "✓ Use Azure Blob Storage premium tier for inference latency",
    "✓ Enable Azure CDN for global distribution",
    "✓ Use Static Web Apps for automatic deployments",
    "✓ Monitor with Application Insights",
  ],

  netlify: [
    "✓ Use Netlify Large Media for model files",
    "✓ Enable Netlify Functions for serverless inference",
    "✓ Use Netlify Analytics for performance monitoring",
    "✓ Set up automatic deployments from Git",
  ],
};

export default deploymentConfigs;
