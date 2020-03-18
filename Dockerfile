FROM node:13-alpine

# Create app directory
WORKDIR /opt/code

# Copy dependencies manifests
COPY package.json yarn.lock ./

# Install app dependencies
RUN yarn install --production

# Bundle app source
COPY . .

EXPOSE 3000
CMD [ "yarn", "start" ]
