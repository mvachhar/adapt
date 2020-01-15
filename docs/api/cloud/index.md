---
id: overview
title: Adapt Cloud API Overview
---

The Adapt Cloud library is a collection of Adapt Components, Hooks,
Deployment Plugins, and utilities to make it simple to create Adapt Specifications for your app deployments.

The library is divided into a few technology sections, shown below.

The complete list of all APIs can be found [here](./cloud.md).

## General

This section contains Components and other items not specific to any particular technologies.

### Components

The Components in this section are all abstract, so they cannot be deployed directly.
However, there are technology-specific Components that can be used in Style Sheets to replace the abstract Components.

:::important Adapt Best Practice
Typically, your Adapt Specification should be written using the abstract Components from this section of the library.
You then apply a Style Sheet that maps the abstract Component into a specific, concrete Component.
For more information, see the Adapt User Guide.
:::

- [Compute](./cloud.compute.md)
- [Container](./cloud.container.md)
- [NetworkService](./cloud.networkservice.md)
- [Service](./cloud.service.md)
- [HttpServer](./cloud.http.httpserver.md)
- [UrlRouter](./cloud.http.urlrouter.md)

## Action

Library for creating simple Primitive Components

### Components

- [Action](./cloud.action.action.md)
- [Command](./cloud.action.command.md)

## AWS

### Components

- [EC2Instance](./cloud.aws.ec2instance.md)
- [EIPAssociation](./cloud.aws.eipassociation.md)

### Utilities

- [loadAwsCreds(options)](./cloud.aws.loadawscreds.md)
- [withCredentials(Wrapped, Ctx)](./cloud.aws.withcredentials.md)

## Docker

### Components

- [DockerContainer](./cloud.docker.dockercontainer.md)
- [LocalDockerImage](./cloud.docker.localdockerimage.md)
- [LocalDockerRegistry](./cloud.docker.localdockerregistry.md)
- [NetworkService](./cloud.docker.networkservice.md)
- [RegistryDockerImage](./cloud.docker.registrydockerimage.md)
- [ServiceContainerSet](./cloud.docker.servicecontainerset.md)

## Kubernetes

### Components

- [Container](./cloud.k8s.container.md)
- [K8sContainer](./cloud.k8s.k8scontainer.md)
- [Pod](./cloud.k8s.pod.md)
- [Resource](./cloud.k8s.resource.md)
- [Service](./cloud.k8s.service.md)
- [ServiceDeployment](./cloud.k8s.servicedeployment.md)

## MongoDB

### Components

- [MongoDB](./cloud.mongodb.mongodb.md)
- [TestMongoDB](./cloud.mongodb.testmongodb.md)

## Nginx

### Components

- [HttpServer](./cloud.nginx.httpserver.md)
- [UrlRouter](./cloud.nginx.urlrouter.md)

## Node.js

### Components

- [LocalNodeImage](./cloud.nodejs.localnodeimage.md)
- [NodeService](./cloud.nodejs.nodeservice.md)
- [ReactApp](./cloud.nodejs.reactapp.md)

## Postgres

### Components

- [Postgres](./cloud.postgres.postgres.md)
- [PostgresProvider](./cloud.postgres.postgresprovider.md)
- [TestPostgres](./cloud.postgres.testpostgres.md)
- [PreloadedPostgresImage](./cloud.postgres.preloadedpostgresimage.md)

## Redis

### Components

- [Redis](./cloud.redis.redis.md)
- [TestRedis](./cloud.redis.testredis.md)
