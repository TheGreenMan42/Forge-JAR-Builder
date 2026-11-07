
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless \
    curl \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Устанавливаем Gradle 8.1.1
RUN curl -fsSL \
    https://services.gradle.org/distributions/gradle-8.1.1-bin.zip \
    -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s /opt/gradle-8.1.1/bin/gradle /usr/local/bin/gradle \
    && rm /tmp/gradle.zip

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production

EXPOSE 10000

CMD ["npm", "start"]
