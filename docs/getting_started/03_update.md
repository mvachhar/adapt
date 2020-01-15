---
id: update
title: "Add Code and Update - MovieDB App"
---

<!-- DOCTOC SKIP -->

## Writing the Real Application Code

As we've seen, the starter template we used with `adapt new` has created a default set of code for both our front end and back end application.
If we were writing our app from scratch, we'd start writing some React code in the `frontend/src` directory and some Node.js code for our API in the `backend` directory.
But for this guide, we'll simply copy in some already-written code for our movie database app, using `curl`.

:::important
Make sure you're in the `moviedb/deploy` directory before you run the following command.
:::

<!-- doctest command -->

```console
curl https://gitlab.com/adpt/gsg-moviedb/-/archive/v2/gsg-moviedb-v2.tar.gz | tar -zxv --strip=1 -C ..
```

This command should have added:

* Some new React UI code in `moviedb/frontend`.
* Some new Node.js code in `moviedb/backend`.
* A file with some test data `moviedb/deploy/test_db.sql` that will be pre-loaded into the Postgres database when we update the deployment.

## Update!

The `adapt update` command will re-build and push the code changes we just made to our existing Docker deployment.
It will also populate the database with the new test data.
<!-- doctest command -->

```console
adapt update movieapp
```

<!-- doctest output { matchRegex: "Deployment movieapp updated successfully." } -->

## Test Your New MovieDB App

Congratulations!
You have now deployed the complete infrastructure for your new MovieDB app.

Test your newly deployed app by opening the same link in your browser again: [http://localhost:8080](http://localhost:8080)

<!-- doctest exec { cmd: "$HOSTCURL http://localhost:8080", matchRegex: "<title>Unbounded Movie Database</title>" } -->
<!-- doctest exec { cmd: "$HOSTCURL http://localhost:8080/api/search/batman", matchRegex: "Lego Batman Movie" } -->

:::important
You will most likely need to force your browser to hard refresh the page (reload while bypassing the browser cache).
Instructions for most browsers can be found [here](https://en.wikipedia.org/wiki/Wikipedia:Bypass_your_cache#Bypassing_cache).
:::

You should now see a page that says **Unbounded Movie Database**, like the one below.
Type into the search box to get a list of matching movies.
Try typing `batman` if your searches turn up empty.

![MovieDB Screen Shot](assets/getting_started/moviedb.png)

## Change and Repeat

You can now make any changes to the app you'd like and each time you run the `adapt update` command from above, Adapt will re-build any necessary images and automatically re-deploy to your local Docker host.
(Note: Don't forget to make your browser do a hard refresh.)
